# Security, Concurrency & Race Condition Analysis

## 1. Connection Session Fencing (Anti-Replay & Anti-Spoofing)

### A. The Replay & Lingering Connection Attack Vector
Without session fencing, if Device A reconnects over WebSocket 2 while WebSocket 1 is half-open on a proxy or delayed:
1. WebSocket 1 could process late in-flight `TASK_PROGRESS` or `TASK_COMPLETE` messages, overwriting progress from WebSocket 2.
2. WebSocket 1 could claim a task intended for the active connection, causing tasks to be assigned to a dead or dying connection.
3. When WebSocket 1 finally disconnected, a naive disconnect handler would mark Device A as `offline`, even though WebSocket 2 was actively running!

### B. The Fencing Implementation
1. **Cryptographic Incarnation ID**: Every newly authenticated WebSocket receives `sessionId = crypto.randomUUID()`.
2. **Session Eviction**: Prior connections matching the same `deviceId` are actively closed (`code: 1008`) and their active in-flight mutating tasks failed closed.
3. **Strict Gate on Every Gateway Message**:
   ```typescript
   const activeSession = this.getActiveSession(authenticatedDeviceId);
   if (activeSession && activeSession.sessionId !== currentSessionId) {
     ws.send(JSON.stringify({ type: 'ERROR', error: 'SESSION_FENCED: Session is no longer active' }));
     ws.close(1008, 'Session fenced');
     return;
   }
   ```
4. **Idempotent Disconnect Handling**:
   When `webSocketClose` or `webSocketError` fires:
   - If `closingSocket.sessionId !== activeSession.sessionId`, the close event is ignored for offline status purposes.
   - The device is only marked `offline` when the currently active session closes and no other healthy sockets exist.

---

## 2. Mutating Task Fail-Closed Guarantee (No Uncontrolled Retry)

### A. The Partial Side-Effect Problem
When a task has capabilities with local side effects:
- `local:write_file`
- `local:patch_file`
- `local:create_directory`
- `local:run_tests`
- `local:build_project`
- `local:raw_shell`

If the worker connection drops or the lease expires while `status === 'running'`:
- The Gateway cannot verify whether the local disk mutation was 0% applied, 50% applied, or 100% applied before network drop.
- **Blind automatic re-queueing violates idempotency and could corrupt workspaces or run commands twice.**

### B. Fail-Closed Remediation
1. If a side-effect task has its lease expire while `status === 'running'`:
   - It is marked `status = 'stale'`, `retryPolicy.requeueOnStale = false`.
   - Error code: `MUTATION_UNCERTAIN_ON_STALE`.
   - Manual operator intervention / re-submission is required.
2. If a session holding a running side-effect task is superseded:
   - It is marked `status = 'stale'`.
   - Error code: `SESSION_SUPERSEDED_MUTATION_UNCERTAIN`.
3. Read-only inspection tasks (`local:read_file`, `local:git_status`, `local:list_projects`, etc.) remain safely retryable.

---

## 3. Concurrency & Scope Isolation

- **Cross-Device Parallelism**: Each device maintains its own independent session. The Gateway supports concurrent parallel task claims across `win11-arm64-workstation` and `win11-arm64-node2` without a global single-execution lock.
- **Read-Only Scope Enforcement**: Tokens provisioned with `local:read` (such as `win11-arm64-node2`) are blocked by `ScopeChecker` from claiming or executing write/shell capabilities.
- **Project Isolation**: Workspace paths are validated against each node's local configuration, preventing path traversal across machines.
