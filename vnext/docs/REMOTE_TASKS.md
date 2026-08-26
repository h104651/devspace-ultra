# DevSpace Ultra — Durable Task Lifecycle & Protocol

## 1. Task State Machine

Tasks progress through a strict, deterministic state machine:

```text
       +----------+
       |  queued  |<--------------------+
       +----+-----+                     | (stale recovery / retry)
            |                           |
            v (TASK_CLAIM_POLL)         |
       +----+-----+                     |
       | claimed  |---------------------+
       +----+-----+                     |
            | (TASK_ACK)                |
            v                           |
    +-------+--------+                  |
    |  acknowledged  |------------------+
    +-------+--------+                  |
            | (TASK_PROGRESS / start)   |
            v                           |
       +----+-----+                     |
       | running  |---------------------+
       +----+-----+
            |
      +-----+-----+----------------+
      |           |                |
      v           v                v
+-----------+ +--------+     +-----------+
| succeeded | | failed |     | cancelled |
+-----------+ +--------+     +-----------+
```

---

## 2. States Specification

| State | Description |
|---|---|
| `queued` | Task is stored in durable store and waiting for an available worker or backend runner. |
| `claimed` | A worker has claimed the task. A time-limited lease (`leaseExpiresAt`) is issued. |
| `acknowledged` | The worker sent `TASK_ACK` confirming it received the task payload and is preparing to execute. |
| `running` | Worker is actively executing the task and sending periodic heartbeats. |
| `retrying` | An error occurred or the lease expired, and the task is scheduled to be requeued after exponential backoff. |
| `succeeded` | Task finished successfully. Results and artifacts are permanently stored. |
| `failed` | Task failed and exhausted its retry budget. Structured error is recorded. |
| `cancelled` | Task was cancelled by administrative action or API request. |
| `stale` | Task lease expired repeatedly without worker heartbeats and exhausted max retries. |

---

## 3. Leases & Heartbeats

* **Lease Duration**: Default 60 seconds (customizable per task).
* **Worker Heartbeats**: Every 10 seconds, the Local Agent sends `AGENT_HEARTBEAT` with a list of active `taskIds`.
* **Automatic Renewal**: The Gateway renews the lease expiration timestamp (`leaseExpiresAt = Date.now() + leaseDurationMs`) upon each heartbeat.
* **Crash Detection**: If a worker machine reboots or loses Internet connectivity, `LeaseMonitor` detects `Date.now() > leaseExpiresAt`, reclaims the task, and puts it back into `queued` status for other workers.
