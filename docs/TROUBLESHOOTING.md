# DevSpace Ultra — Troubleshooting & Operational Diagnostics

## 1. Common Diagnostics & Health Checks

### Check Gateway Health
```bash
curl http://localhost:4000/health
```
Expected output:
```json
{
  "status": "healthy",
  "service": "devspace-ultra-gateway",
  "version": "2.0.0",
  "connectedAgents": 1,
  "killSwitch": "ACTIVE"
}
```

### Inspect Audit Logs
```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" http://localhost:4000/api/audit?limit=20
```

---

## 2. Common Issues & Solutions

### Issue 1: `AUTH_REQUIRED` or `AUTH_INVALID`
* **Cause**: Missing `Authorization: Bearer <token>` header or forged/expired token.
* **Fix**: Ensure your client uses the token outputted during `npm run gateway` (or registered via `authManager.registerClient`).

### Issue 2: `AUTH_FORBIDDEN: Required scope '<scope>' not granted`
* **Cause**: Token lacks the permission required for the specific capability (e.g. attempting `local:write_file` with only `kaggle:read` scope).
* **Fix**: Re-issue token with the appropriate scope or assign `admin` scope.

### Issue 3: Local Agent Disconnected / `Agent should be connected`
* **Cause**: `GATEWAY_URL` is unreachable or device token was revoked.
* **Fix**:
  1. Check gateway URL in local agent's `.env`.
  2. Verify firewall allows outbound connections to the Gateway port.
  3. Ensure `AGENT_TOKEN` matches the registered device.

### Issue 4: `WORKSPACE_ACCESS_DENIED`
* **Cause**: Local task requested a file or workspace outside `ALLOWED_WORKSPACES`.
* **Fix**: Add the target directory path to `ALLOWED_WORKSPACES` in the local agent's `.env` configuration.

### Issue 5: `RAW_SHELL_DENIED`
* **Cause**: Attempted to run `local:raw_shell` while `ALLOW_RAW_SHELL=false`.
* **Fix**: Raw shell is intentionally disabled for zero-trust security. Use high-level capabilities (`local:run_tests`, `local:build_project`, `local:git_status`) or explicitly enable `ALLOW_RAW_SHELL=true` with scope `raw_shell:run`.
