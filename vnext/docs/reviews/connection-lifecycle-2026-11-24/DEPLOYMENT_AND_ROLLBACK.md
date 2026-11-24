# Deployment, Rollback & Agent Upgrade Order Plan

## 1. Safety Gates & Strict Constraints

- **Repository**: `h104651/devspace-ultra`
- **Branch**: `fix/vnext-agent-connection-lifecycle`
- **Current Base SHA (`main`)**: `62f1b76376817e7bcc357e0883a988d08f394ab2`
- **Production Status**: Currently running Gateway Version `bdc28ad2-e9ab-4383-bdc8-96511c13faca`.
- **Constraint**: **NO automatic merge, NO direct push to `main`, and NO production deployment during this turn.** Stop strictly at PR Ready for Review.

---

## 2. Agent Upgrade Sequence & Compatibility

### Backward & Forward Compatibility Guarantee
The connection lifecycle hardening changes are fully backward and forward compatible:
1. **Old Agent + New Gateway**:
   - An old agent connects and sends `AGENT_REGISTER`.
   - The new Gateway creates a `sessionId`, serializes it in the WebSocket attachment, and tracks heartbeat timestamps.
   - The old agent simply ignores the optional `sessionId` field in `AGENT_REGISTERED`.
   - If the old agent disconnects abruptly, the Gateway's Watchdog catches it within 45s and marks it offline.
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
  npx wrangler rollback --version-id bdc28ad2-e9ab-4383-bdc8-96511c13faca
  ```
- **SQLite Schema Invariance**:
  - The `devices` table already contained `lastHeartbeatAt INTEGER`.
  - No table alterations or breaking column changes were made.
  - The previous Gateway version can read and write to the existing SQLite database without migration or data loss.
