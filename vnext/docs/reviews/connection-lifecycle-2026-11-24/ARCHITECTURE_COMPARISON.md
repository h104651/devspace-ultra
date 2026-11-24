# Connection Lifecycle & Session Fencing Architecture Comparison

## 1. Executive Summary

During production validation of multi-device routing (PR #23), an edge scenario was identified during test `M08` (Offline & Reconnection Test):
- A terminated agent on Node 2 remained reported as `online` with 1 lingering connection for $>83$ seconds after graceful client stop (`Ctrl+C`).
- Node 1 accumulated multiple lingering connections (`connectionCount: 3`, `duplicateConnection: true`) across previous network reconnects.
- `lastHeartbeatAt` regressed from `14:26:09` to `14:23:58` upon Durable Object cold start / SQLite hydration.

This hardening release implements **Connection Session Fencing**, **Unified Connection Health Policy**, **Monotonic Persistent Heartbeats**, **Graceful Client Shutdown Handshake**, and a **Coordinated Durable Object Watchdog Alarm**.

---

## 2. Before vs. After Architecture

### A. Session Identification & Deduplication

| Dimension | Before (PR #23) | After (This Release) |
| :--- | :--- | :--- |
| **Session Identification** | No session identity; WebSockets only tracked by `deviceId`. | Every authenticated WebSocket receives a unique `sessionId: crypto.randomUUID()`. |
| **Attachment Schema** | `{ deviceId, name, platform, capabilities, connectedAt }` | `{ sessionId, deviceId, name, platform, capabilities, connectedAt, lastHeartbeatAt }` |
| **Duplicate Reconnection** | New connection created another attachment; old sockets remained indefinitely in `ctx.getWebSockets()`. | New connection evicts previous sockets for the same `deviceId` with `close(1008, 'Superseded')`. |
| **Session Fencing** | Messages accepted as long as `deviceId` matched token. Old sockets could report events. | All incoming messages (`HEARTBEAT`, `POLL`, `ACK`, `PROGRESS`, `COMPLETE`, `FAIL`) verify `sessionId === activeSessionId`. Outdated sockets are rejected with `SESSION_FENCED`. |

### B. Connection Health & Online Status Determination

| Dimension | Before (PR #23) | After (This Release) |
| :--- | :--- | :--- |
| **Health Metric** | Solely `liveConns.length > 0`. | Physical socket open **AND** `(now - lastHeartbeatAt) <= 45_000ms`. |
| **Facade Heartbeat** | Hardcoded `lastHeartbeatAt: Date.now()` (faked live heartbeat). | Real received heartbeat from WebSocket attachment / memory ledger. |
| **Heartbeat Persistence** | In-memory only in `AuthManager`; never written to SQLite on heartbeat. | Persisted monotonically in SQLite via `UPDATE devices SET lastHeartbeatAt = MAX(..., ?)`. |
| **Offline Detection** | Relied purely on edge TCP termination (often minutes). | Immediate on `close`/`error` callback, or within 45s via real-time check and Watchdog eviction. |

### C. Task Ownership & Safety on Interruption

| Dimension | Before (PR #23) | After (This Release) |
| :--- | :--- | :--- |
| **Lease Tracking** | `task.lease.claimedBy = deviceId` | `task.lease.claimedBy = deviceId`, `task.lease.claimedSessionId = sessionId`. |
| **Result Forgery** | Any socket with same `deviceId` could acknowledge or complete task. | Only the specific `sessionId` that claimed the task can report progress or completion. |
| **Mutating Tasks** | All tasks default `requeueOnStale: true` (risk of blind re-execution). | Mutating tasks (`write_file`, `patch_file`, `create_directory`, `run_tests`, `build_project`, `raw_shell`) fail-closed (`stale`, `SESSION_SUPERSEDED_MUTATION_UNCERTAIN`) requiring manual recovery. |
| **Read-Only Tasks** | Same as mutating tasks. | Read-only inspection tasks safely requeue for retry. |

### D. Durable Object Alarm Coordination

| Dimension | Before (PR #23) | After (This Release) |
| :--- | :--- | :--- |
| **Watchdog Alarm** | No connection watchdog alarm existed; only `rearmKaggleAlarm`. | Unified alarm scheduler coordinating Kaggle polls and bounded 30s connection watchdog. |
| **Idle Cost Guard** | N/A | When no WebSockets are connected and no Kaggle polls are pending, alarm is deleted (0 idle DO cost). |
| **Task Routing Isolation** | Task routing trusted `getConnectedAgents()`. | `TaskRouter` synchronously evaluates `healthyOnly: true`, excluding stale sockets in real time before watchdog runs. |

### E. Agent Client Termination

| Dimension | Before (PR #23) | After (This Release) |
| :--- | :--- | :--- |
| **SIGINT / SIGTERM** | `agent.stop(); process.exit(0);` synchronously on same tick (dropped TLS without close handshake). | Asynchronous graceful stop: cancels timers, stops task polling, awaits in-flight tasks (up to bounded timeout), performs WebSocket 4-way close handshake (code 1000), then exits. |
| **Windows Ctrl+C** | Abrupt process abortion. | Handled via graceful signal trap with 3s bounded timeout. |
