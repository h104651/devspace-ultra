# Deployment, Rollback & Agent Upgrade Order Plan

## 1. Safety Gates & Strict Constraints

- **Repository**: `h104651/devspace-ultra`
- **Branch**: `fix/vnext-agent-connection-lifecycle`
- **Current Base SHA (`main`)**: `62f1b76376817e7bcc357e0883a988d08f394ab2`
- **Production baseline**: The previously recorded `bdc28ad2-e9ab-4383-bdc8-96511c13faca` predates the ADMIN_SECRET rotation and is NOT an approved rollback target. The last observed post-rotation dashboard version began `df129ec3`. Before any approved deployment, read the current active deployment and its complete version ID, verify the intended secret bindings without retrieving values, and record the exact pre-change version.
- **Constraint**: **NO automatic merge, NO direct push to `main`, and NO production deployment during this turn.** Stop strictly at PR Ready for Review.

---

## 2. Agent Upgrade Sequence & Compatibility

### Backward & Forward Compatibility Guarantee
Compatibility must be verified in staging before any production deployment. The intended transition is:
1. **Old Agent + New Gateway**:
   - An old agent connects and sends `AGENT_REGISTER`.
   - The new Gateway creates a `sessionId`, serializes it in the WebSocket attachment, and tracks heartbeat timestamps.
   - The old agent simply ignores the optional `sessionId` field in `AGENT_REGISTERED`.
   - Health queries use a 45-second heartbeat TTL; watchdog cleanup runs on its own deadline and is subject to runtime scheduling. A legacy client may finish its first attempt, but cannot claim a replay of an already attempted local task. Upgrade the client to resume safe read-only replays. Pre-upgrade sockets without durable session authority must reconnect; drain local tasks first.
2. **New Agent + Old Gateway**:
   - The new agent performs graceful shutdown on `SIGINT` / `SIGTERM`.
   - Even if the old Gateway had an empty `webSocketClose`, the orderly WebSocket close frame (code 1000) causes Cloudflare Edge to immediately tear down the edge proxy connection, expediting edge offline detection.

### Recommended Upgrade Order (Post-Merge & Approval)
1. **Phase 1: Production Gateway Deployment**: Deploy hardened Cloudflare Worker / Durable Object.
2. **Phase 2: Agent Client Upgrade**: Update local agent CLI on `win11-arm64-node2` and `win11-arm64-workstation`.

---

## 3. Rollback Plan

If any regression occurs after production deployment:
- **Instant Cloudflare Worker Rollback**:
  ```bash
  npx wrangler rollback --version-id <VERIFIED_POST_ROTATION_BASELINE>
  ```
- **SQLite Schema Invariance**:
  - The `devices` table already contained `lastHeartbeatAt INTEGER`.
  - No table alterations or breaking column changes were made.
  - The previous Gateway version can read and write to the existing SQLite database without migration or data loss.

## 4. Required release gates after independent review

- Rebuild tracked `vnext/dist` from the exact reviewed TypeScript HEAD; do not run a stale compiled agent.
- Verify actual CI workflow conditions and deploy-job skip status on PR events; CI success is not deployment approval.
- Drain active local tasks before gateway or client rollout. Legacy sessionless tasks must not be silently replayed or adopted.
- Run actual WebSocket and isolated Workers runtime tests, including duplicate rejection, stale takeover, lost ACK/RUNNING, attempt fencing, alarm coexistence and real process shutdown; mocks alone do not certify the production edge lifecycle.
- Confirm the live post-rotation version ID and rollback secret-binding semantics with an authorized operator; if uncertain, stop. Do not change ADMIN_SECRET or MASTER_SECRET to make rollback work.
