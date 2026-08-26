# DevSpace Ultra — Security Architecture

## 1. Zero Trust Principles

DevSpace Ultra treats every incoming request, connected worker, external web page, and remote script as untrusted until cryptographically verified.

### Core Security Rules:
1. **No Inbound Exposure**: Local machines never open listening ports to the public Internet.
2. **Explicit Granular Scopes**: Every client and device possesses an explicit list of authorized capabilities.
3. **No Secret Leaks**: Automated redaction sweeps all logs, error messages, and task summaries.
4. **Immediate Revocation**: The Kill Switch system can instantly invalidate compromised devices or halt all execution.
5. **Prompt-Injection Immunity**: LLM outputs and prompt strings cannot elevate permissions or bypass permission checks.

---

## 2. Authentication & Credential Architecture

### Token Format
Tokens use HMAC-SHA256 signatures signed with the Gateway's `MASTER_SECRET`:
```text
dsu_<type>_<base64url_payload>.<signature>
```
* `type`: `client` or `device`
* `payload`: Includes `tokenId`, `subjectId`, `scopes`, `issuedAt`, `expiresAt`.

### Token Expiration & Rotation
* Default client tokens: 30 days.
* Tokens can be revoked dynamically by adding `tokenId` to the revocation registry.
* Revoking a `deviceId` instantly terminates its active WebSocket connections.

---

## 3. Scope Hierarchy & Matrix

| Scope | Allowed Capabilities |
|---|---|
| `kaggle:submit` | `kaggle:run`, `kaggle:status`, `kaggle:logs`, `kaggle:artifacts`, `kaggle:cancel` |
| `kaggle:read` | `kaggle:status`, `kaggle:logs`, `kaggle:artifacts` |
| `local:read` | `local:git_status`, `local:read_file`, `remote_task_status`, `remote_task_logs`, `remote_task_artifacts` |
| `local:write` | `local:write_file`, `local:patch_file`, `local:read_file`, `remote_task_cancel` |
| `local:test` | `local:run_tests`, `local:build_project` |
| `swarm:dispatch` | `swarm:dispatch`, `swarm:status` |
| `raw_shell:run` | `local:raw_shell` *(Strictly disabled by default on Local Agent)* |
| `admin` | Full access across all backends, devices, audit logs, and kill switch controls |

---

## 4. Emergency Kill Switch

The Kill Switch provides multi-tiered emergency controls:
1. **Global Emergency Stop (`EMERGENCY_STOP`)**: Immediately denies all task submissions and claims across the entire system.
2. **Device Revocation (`REVOKE_DEVICE`)**: Disconnects and permanently blocks a specific compromised machine.
3. **Client Revocation (`REVOKE_CLIENT`)**: Blocks an API key or ChatGPT client token.
4. **Backend Suspension (`disableKaggleExecution` / `disableLocalAgentExecution`)**: Suspends specific compute backends without affecting others.

Trigger via CLI or MCP:
```bash
curl -X POST http://localhost:4000/api/kill-switch \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"action": "EMERGENCY_STOP", "reason": "Suspicious activity detected"}'
```
