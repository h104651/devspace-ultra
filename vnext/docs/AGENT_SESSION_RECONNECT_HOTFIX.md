# Agent session reconnect hotfix

Incident: an abnormal WebSocket close (1006) can be followed by registration before the gateway observes the old socket close or its 45 s heartbeat TTL expires. The previous duplicate check treated this as a permanent policy rejection (Agent exit 12), stopping the Windows supervisor.

## Contract

- Each LocalAgentClient creates a random 256-bit proof in memory and a monotonically increasing registration sequence. The production CLI acquires its exclusive device lock before starting the client. The proof is not a hardware attestation or an IPC/lock secret.
- Normal device-token authentication and capability filtering still run first. Gateway stores only a digest in the session attachment (or Node session record). Same proof + strictly newer sequence permits replacement of a healthy incumbent. A different proof or absent proof cannot replace a healthy incumbent. Old agents remain compatible with legacy behavior.
- Existing session/attempt fencing and task-store reconciliation remain authoritative. Read-only interrupted tasks may requeue; uncertain mutations are stale, not replayed. The Agent waits for old local executors to finish before reconnecting.
- Registration ACK timeout is 15 seconds. Backoff resets only on AGENT_REGISTERED. For a legacy gateway returning the exact old duplicate-session reason after a registered connection's 1006, a new Agent may retry once after 46 seconds. Invalid proof, stale sequence, revoked token, fenced/superseded and genuine duplicate-instance rejection remain non-retryable.
- Proof is a bearer secret sent through the existing authenticated transport; production requires WSS. It is not persisted on disk or included in audit logs. A process restart creates a new proof and cannot take over a still-healthy prior process.

## Release gates (not yet verified)

1. CI build, all tests, Wrangler dry-run and tracked dist equivalence.
2. Isolated Windows ARM64 test with disposable gateway/device credentials: abnormal 1006 while incumbent remains healthy, 10 repetitions, duplicate/different process denial, lost ACK, late close/error, no overlapping execution, mutation fencing, lock/daemon behavior, and legacy gateway fallback.
3. Production inventory active/stale/quarantined all zero; separate explicit authorization for merge and production deployment. No production tokens in tests.
4. Controlled rollout: validate backwards compatibility before production. Upgrade workstation 1 Agent using approved service SOP and new release, coordinate gateway deployment with service stop/drain and rollback; verify reconnect and heartbeat. Upgrade workstation 2 using the final same release, preserving its read-only permissions and prepared config/backup.
5. Do not change TTL, token scopes, ACL, task dispatch policy, or daemon exit codes. Do not claim real-machine verification from a mock test.

Rollback requires compatible gateway/agent versions and complete prior launcher/config/release; never delete a retained lock without process and task audit.
