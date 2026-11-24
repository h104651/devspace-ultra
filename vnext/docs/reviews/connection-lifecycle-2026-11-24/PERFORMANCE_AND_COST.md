# Performance, Resource Cost & Idle Guard Analysis

## 1. Durable Object Execution Cost Guard

### A. Alarm Scheduling & Idle Zero-Cost Pattern
- **Problem**: A naive watchdog timer in a Durable Object can trigger recurring alarms indefinitely, consuming execution time and preventing DO hibernation when no clients are connected.
- **Solution (`rearmUnifiedAlarm`)**:
  - The Watchdog alarm is scheduled **only when active WebSockets exist** in `this.ctx.getWebSockets()`.
  - When all agents disconnect or are evicted and no Kaggle polling tasks are pending, `this.ctx.storage.deleteAlarm()` is called.
  - **Result**: Once all agents disconnect, the Durable Object hibernates and incurs **0 DO wake-up requests and 0 CPU seconds**.

### B. Coordination with Kaggle Long-Polling Alarm
- Cloudflare Durable Objects enforce a **single active alarm** per instance (`ctx.storage.setAlarm(timestamp)`).
- `rearmUnifiedAlarm` evaluates both the earliest pending Kaggle polling due time and the 30-second Watchdog due time:
  $$\text{nextAlarmTime} = \min(\text{earliestKagglePollDue}, \text{watchdogDueAt})$$
- When `alarm()` executes:
  1. Any Kaggle task due within $+250\text{ms}$ is polled.
  2. Any stale WebSocket with $(now - \text{lastHeartbeatAt}) > 45\text{s}$ is evicted.
  3. Alarms are re-armed cohesively.
- **Result**: No alarm collisions; Kaggle tasks are never starved or overwritten.

---

## 2. In-Memory and SQLite IO Efficiency

### A. Heartbeat Monotonic Writes
- Every 15 seconds, each connected agent sends an `AGENT_HEARTBEAT` message.
- Rather than serializing the entire `DeviceRecord` JSON payload, the Gateway executes:
  ```sql
  UPDATE devices SET lastHeartbeatAt = MAX(COALESCE(lastHeartbeatAt, 0), ?) WHERE deviceId = ?
  ```
- **Execution Cost**: In Cloudflare Durable Objects, SQLite is embedded and executed in-process on the local NVMe/RAM tier. A single row indexed primary-key update takes $<0.1\text{ms}$.
- **Network Overhead**: WebSocket binary/string payload is under 128 bytes per heartbeat.

### B. Real-Time Status Queries (O(1) Memory Filtering)
- `TaskRouter.routeTaskSubmit()` and `handleDeviceStatus()` do not wait for the background alarm.
- They evaluate `(now - lastHeartbeatAt) <= 45_000ms` in memory synchronously on incoming requests.
- **Overhead**: $\approx 10\text{ns}$ per session check; 0 database queries required for routing health preflight.
