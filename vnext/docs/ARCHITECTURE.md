# DevSpace Ultra — System Architecture

## 1. Overview & Data Flow

DevSpace Ultra decouples remote AI clients (like ChatGPT or external orchestrators) from local desktop environments and cloud compute providers using a centralized Gateway and an outbound-only connection model.

```mermaid
sequenceDiagram
    autonumber
    participant ChatGPT as ChatGPT / Remote MCP
    participant Gateway as DevSpace Ultra Gateway
    participant TaskStore as Durable Task Store
    participant Agent as Windows Local Agent (Outbound)
    participant Kaggle as Kaggle Free GPU Backend

    ChatGPT->>Gateway: POST /api/tasks (kaggle_run or local:run_tests)
    Gateway->>Gateway: Validate Bearer Token & Scopes
    Gateway->>TaskStore: Persist Task (queued / running)
    Gateway-->>ChatGPT: 202 Accepted (taskId, status)

    alt Local Execution
        Agent->>Gateway: WebSocket Poll (TASK_CLAIM_POLL)
        Gateway->>Agent: TASK_ASSIGNED (taskId, payload)
        Agent->>Gateway: TASK_ACK & TASK_PROGRESS
        Agent->>Agent: Execute (git / test / build / file)
        Agent->>Gateway: TASK_LOG_APPEND & TASK_COMPLETE
        Gateway->>TaskStore: Update Task (succeeded + result)
    else Kaggle Execution
        Gateway->>Kaggle: Push Kernel & Start Run
        loop Background Poller (every 15s)
            Gateway->>Kaggle: Query Status
        end
        Kaggle-->>Gateway: Execution Finished
        Gateway->>Kaggle: Download Logs & Artifacts
        Gateway->>TaskStore: Update Task (succeeded + artifacts)
    end

    ChatGPT->>Gateway: GET /api/tasks/:taskId (remote_task_status)
    Gateway-->>ChatGPT: Task State, Output Metrics & Logs
```

---

## 2. Core Components

### 2.1 DevSpace Ultra Gateway
* **HTTP REST API & WebSocket Server**: Express + `ws` serving REST endpoints for task lifecycle and WebSocket endpoints for agent connectivity.
* **AuthManager**: Cryptographically secure token issuer and validator (`dsu_client_*`, `dsu_device_*`).
* **TaskRouter**: Decouples API callers from underlying backends, enforces scopes and idempotency keys.
* **LeaseMonitor**: Background daemon that continuously scans for expired worker leases, reclaiming abandoned tasks back to the queue or marking them stale after retry thresholds.

### 2.2 Storage Layer
* **TaskStore**: ACID-like file-backed task persistence in `.devspace-storage/tasks/`. Tasks survive process crashes, server restarts, and connection loss.
* **ArtifactStore**: Stores logs, results, CSVs, and model checkpoints with SHA256 integrity hashing and size quota limits.
* **IdempotencyStore**: Maintains a sliding-window registry of `clientRequestId` and `idempotencyKey` hashes to prevent duplicate task execution.

### 2.3 Local Agent (Outbound-Only)
* **WebSocket Client**: Initiates outbound connection to `ws://` / `wss://` gateway endpoint.
* **TaskExecutor**: Implements high-level, capability-restricted operations (`local:git_status`, `local:read_file`, `local:patch_file`, `local:run_tests`, `local:build_project`).
* **Heartbeat & Lease Manager**: Renews lease every 10 seconds for all active running tasks.

### 2.4 Kaggle Backend
* **Autonomous Poller**: Pushes kernels to Kaggle, immediately returns a persistent `taskId`, and polls kernel status in background.
* **Artifact Ingestion**: Automatically downloads `stdout.log`, `result.json`, and generated files into the Gateway ArtifactStore upon job completion.
