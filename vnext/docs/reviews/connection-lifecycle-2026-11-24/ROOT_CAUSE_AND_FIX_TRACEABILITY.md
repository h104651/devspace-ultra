# Root Cause Analysis, Fix Implementation & Test Traceability Matrix

## 1. Production Issue Traceability

| Issue ID | Production Symptom | Exact Root Cause | Code Location | Fix Implementation | Test Coverage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ISSUE-1** | Device 2 (`win11-arm64-node2`) showed `online` $>83$s after user terminated agent via `Ctrl+C`. | 1. `process.exit(0)` was called synchronously right after `ws.close()`, killing process before TLS close frame could flush.<br>2. `webSocketClose` in DO was an empty stub (`no-op`).<br>3. `webSocketError` was missing entirely.<br>4. `handleDeviceStatus` evaluated `isOnline = liveConns.length > 0`, ignoring heartbeat timestamps. | `agent-cli.ts:66-67`<br>`gateway-durable-object.ts:1261`<br>`handlers.ts:1298` | 1. Implement async `agent.stop({ timeoutMs })` with WebSocket close frame wait.<br>2. Full `webSocketClose` & `webSocketError` handlers in DO.<br>3. `isSessionHealthy` policy checks `(now - lastHeartbeatAt) <= 45_000ms`. | **T01**, **T02**, **T03**, **T04**, **T05**, **T06** |
| **ISSUE-2** | Device 1 (`win11-arm64-workstation`) accumulated `connectionCount: 3` and `duplicateConnection: true`. | When `AGENT_REGISTER` arrived, DO serialized attachment to the new socket without checking or evicting preexisting sockets for that device. | `gateway-durable-object.ts:1145` | On `AGENT_REGISTER`, scan `ctx.getWebSockets()`, close existing sockets for that `deviceId` with `1008 ('Superseded by new registration')`, and mark them fenced. | **T07**, **T08**, **T18** |
| **ISSUE-3** | `lastHeartbeatAt` regressed from `14:26:09` to `14:23:58` on Node 2. | `updateDeviceHeartbeat` only updated in-memory `AuthManager`. In Cloudflare DO, SQLite `devices` was only written on `AGENT_REGISTER` (`14:23:58`). On DO cold start / rehydration, SQLite's old timestamp overwrote memory. | `gateway-durable-object.ts:1179`<br>`auth-manager.ts:255` | 1. Add `updateDeviceHeartbeat` to `SqliteStorageAdapter` using `MAX(COALESCE(lastHeartbeatAt, 0), ?)`.<br>2. Heartbeat handler persists to SQLite on every heartbeat monotonically. | **T09**, **T10** |
| **ISSUE-4** | Reconnection during active task could cause duplicate execution or forged results. | `TaskLease` only recorded `claimedBy: deviceId`. Old sockets could send `TASK_COMPLETE` or `TASK_CLAIM_POLL`. Mutating tasks were blindly retryable. | `task-store.ts:378`<br>`task-store.ts:695` | 1. Record `claimedSessionId: sessionId` in `TaskLease`.<br>2. Verify `claimedSessionId` on all task actions.<br>3. In-flight mutating tasks fail-closed (`SESSION_SUPERSEDED_MUTATION_UNCERTAIN`) on session interruption. | **T11**, **T12**, **T13**, **T14** |
| **ISSUE-5** | DO Alarm had no connection watchdog and risk of colliding with Kaggle alarm. | DO only had `rearmKaggleAlarm`. No watchdog checked heartbeat TTL for lingering sockets. | `gateway-durable-object.ts:248-282` | Implement `rearmUnifiedAlarm` scheduling `min(kaggleDue, watchdogDue)`. Alarm handler executes both Kaggle polling and stale connection eviction, deleting alarm when idle. | **T19** |

---

## 2. Test Verification Matrix (T01 - T24)

| Test ID | Scenario Description | Expected Outcome | Verification Method | Result |
| :--- | :--- | :--- | :--- | :--- |
| **T01** | Normal registration & heartbeat | `AGENT_REGISTERED` includes `sessionId`; periodic heartbeat acknowledged with `AGENT_HEARTBEAT_ACK`. | Mock WebSocket attached to DO | **PASS** |
| **T02** | Orderly WebSocket Close | Socket closes with code 1000; `webSocketClose` transitions device status to `offline`. | DO `webSocketClose` handler | **PASS** |
| **T03** | Forced termination / unannounced drop | Heartbeat stops; Watchdog detects `now - lastHeartbeatAt > 45s`, closes socket (1000) and marks `offline`. | DO `runWatchdogStaleEviction` | **PASS** |
| **T04** | Sudden network silence | Sockets open but silent: $\le 45$s healthy, $>45$s stale. | `isSessionHealthy` evaluation | **PASS** |
| **T05** | Heartbeat TTL boundary values | Exactly 44,999ms & 45,000ms healthy; 45,001ms stale. | Microsecond boundary tests | **PASS** |
| **T06** | Stale Socket exists, device judged Offline | `handleDeviceStatus` via MCP evaluates live connections; returns `status: 'offline'`, `totalOnline: 0`. | MCP Tool Call Simulation | **PASS** |
| **T07** | Same Device ID Duplicate Registration | Second registration evicts first socket with code 1008 ('Superseded'); first socket closed, second active. | Sequential DO `webSocketMessage` | **PASS** |
| **T08** | New Session created, old Close arrives late | Delayed close from superseded socket does NOT mark device offline; active session remains intact. | Interleaved Register and Close | **PASS** |
| **T09** | Old Session Heartbeat cannot touch new session | Fenced session attempts `AGENT_HEARTBEAT`; rejected with `SESSION_FENCED`, socket closed. | Fenced socket message rejection | **PASS** |
| **T10** | Monotonic Heartbeat Timestamp | Older timestamp does not overwrite newer timestamp in memory or SQLite (`MAX` rule). | Monotonicity stress test | **PASS** |
| **T11** | Old Session cannot claim new tasks | Fenced session attempts `TASK_CLAIM_POLL`; rejected with `SESSION_FENCED`, task remains queued. | Task claim session verification | **PASS** |
| **T12** | Old Session cannot forge task results | Task leased to Session 2; Session 1 attempts `TASK_COMPLETE`; rejected with `SESSION_FENCED`. | Task completion lease check | **PASS** |
| **T13** | In-flight task disconnect & reconnect | Session holding task is superseded; `failTasksForSupersededSession` handles attempt cleanly. | Lifecycle state transition check | **PASS** |
| **T14** | Mutating task fail-closed protection | Running `local:write_file` fails closed into `stale` (`SESSION_SUPERSEDED_MUTATION_UNCERTAIN`), requiring manual intervention. Read-only `local:git_status` safely requeues. | Mutating vs read-only recovery | **PASS** |
| **T15** | Two distinct devices parallel tasks | Device 1 & Device 2 claim and run independent tasks simultaneously without cross-device interference. | Dual device execution | **PASS** |
| **T16** | Offline target device does not misroute | Task targeted to offline Device 2 remains queued; Device 1 polling cannot claim it. | Targeted routing poll test | **PASS** |
| **T17** | Ambiguous device target error | Multiple devices exist; task submit without `targetDeviceId` throws `AMBIGUOUS_DEVICE_TARGET`. | TaskRouter submission gate | **PASS** |
| **T18** | Durable Object Hibernation / session restore | DO in-memory state cleared; `getActiveSession` successfully restores active session from socket attachment. | Hibernation rehydration test | **PASS** |
| **T19** | Watchdog & Kaggle Alarm coexistence | Both Kaggle poll and WebSocket Watchdog scheduled; alarm computes `min(kaggle, watchdog)`; `alarm()` runs both. | DO Alarm dispatcher | **PASS** |
| **T20** | Token revocation & Emergency Stop | Device revoked via KillSwitch; subsequent heartbeat immediately rejected with `DEVICE_REVOKED` and closed. | KillSwitch integration | **PASS** |
| **T21** | Read-only device scope enforcement | Device with `local:read` cannot claim `local:write_file`; submission rejected with `AUTH_FORBIDDEN`. | ScopeChecker capability gate | **PASS** |
| **T22** | Same Project ID cross-device isolation | Tasks for `my-project` on Device A and Device B operate strictly within their own designated agent. | Multi-device project isolation | **PASS** |
| **T23** | Legacy Bootstrap Token compatibility | Valid device bootstrap token validates and authenticates seamlessly. | AuthManager token verification | **PASS** |
| **T24** | Chat Swarm, Kaggle, Artifacts regression | Verifies SwarmOrchestrator, KaggleBackend, and ArtifactStore continue functioning properly. | Regression smoke test | **PASS** |
