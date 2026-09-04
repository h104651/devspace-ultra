# DevSpace Ultra vNext — Blue/Green Migration from Legacy DevSpace

## 1. Migration goal

Move ChatGPT, Kaggle, Local Agent, and core Chat Swarm traffic from the legacy inbound-tunnel architecture to the fixed Cloudflare Worker gateway without losing the currently working connector during the transition.

This is a **blue/green migration**. Do not delete or disable the old connector first.

## 2. Architecture comparison

| Area | Legacy connector | vNext target |
|---|---|---|
| Public ingress | Quick/Named tunnel to local Windows service | Fixed Cloudflare `workers.dev` endpoint |
| Windows network | Public tunnel terminates near local service | Outbound-only WSS Local Agent |
| MCP/OAuth | Local MCP implementation | Cloudflare Worker + GatewayDurableObject |
| Task persistence | Local coordinator/file/process state | Durable Object SQLite + DO storage |
| Large artifacts | Local filesystem | R2 payload + durable metadata |
| Kaggle | Local/runtime-dependent path possible | Worker-compatible `fetch()` HTTP only |
| Kaggle polling | Process timer | Durable Object alarm |
| Core Chat Swarm | Local coordinator + bridge | Durable Object compatibility coordinator |
| Browser wake | Legacy tunnel endpoint | Cloudflare Browser Wake Bridge endpoints |
| Security | Legacy connector policy | OAuth resource binding + least privilege + revocation |

## 3. Keep the legacy connector alive

During migration retain:

- the existing `DevSpace Ultra` ChatGPT app/connector
- the legacy Quick Tunnel used by it
- existing local ChatGPT Classic runtime/update automation

Do not stop `cloudflared` merely because the new Worker passes unit tests or direct HTTP smoke tests.

## 4. Deploy vNext in parallel

Deploy the `vnext` Cloudflare Worker only after:

```text
TypeScript build = PASS
repository automated tests = PASS
Wrangler deploy dry-run = PASS
```

Production Worker URL:

```text
https://devspace-ultra-gateway.abdul-hsu.workers.dev
```

MCP URL:

```text
https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp
```

The Windows Local Agent connects outbound to:

```text
wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent
```

## 5. Create a second ChatGPT connector

Create a new app named for example:

```text
DevSpace Ultra vNext
```

Use:

```text
Server URL: https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp
Authentication: OAuth
Advanced OAuth settings: default/discovery
```

Do not edit/delete the working legacy connector during this stage.

## 6. Real acceptance tests

Repository CI is necessary but not sufficient. The migration is accepted only when an actual ChatGPT conversation using the new connector performs all applicable checks below.

### MCP/OAuth

- OAuth authorization completes.
- ChatGPT refresh/discovery succeeds.
- `kaggle_*`, `remote_task_*`, and core `chat_swarm_*` tools are visible.

### Kaggle

- submit a tiny private CPU task
- observe status transition
- read logs
- retrieve the result/artifact metadata

### Windows Local Agent

- verify the outbound agent is connected
- submit a safe capability such as `local:git_status` or test/status operation
- receive a durable result through the new gateway

### Chat Swarm

- create a small test swarm
- join/bind one test worker
- dispatch a harmless task
- wake/claim it
- submit and collect the result
- verify durable state survives a gateway object restart condition already covered by automated tests

## 7. Legacy parity boundaries

Core Chat Swarm task coordination is migrated to Cloudflare.

Some legacy tools are intentionally **not** treated as automatically migrated because they directly control Windows ChatGPT Classic runtimes or local workspaces, for example runtime/update/elastic-scale PowerShell automation and unrestricted workspace shell/write operations.

Those capabilities require an explicit outbound Local Agent implementation and appropriate scopes before the old connector can be fully retired. Do not fake parity by exposing tool names that cannot safely execute.

The normal ChatGPT OAuth grant remains least privilege and must not gain `admin:*`, arbitrary raw shell, or unrestricted local write access merely to match old tool count.

## 8. Cutover decision

After the real vNext acceptance tests pass, decide whether remaining legacy-only Windows lifecycle/workspace tools are still required.

- If they are not needed, retire the old connector/tunnel.
- If they are needed, keep the legacy connector temporarily or migrate those exact operations through explicit Local Agent capabilities first.

## 9. Retire legacy ingress last

Only after the new ChatGPT connector is confirmed working and all required legacy workflows have a safe replacement:

1. disable/remove the legacy ChatGPT connector
2. stop the old Quick Tunnel/cloudflared process
3. remove obsolete tunnel configuration
4. keep rollback information long enough to verify normal operations

At no point should Windows port `7676` or another local service be exposed publicly as the vNext production solution.
