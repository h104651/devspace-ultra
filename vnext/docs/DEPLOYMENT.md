# DevSpace Ultra vNext — Cloudflare Production Deployment

## Production architecture

The supported production topology is:

```text
ChatGPT
  -> HTTPS/OAuth/MCP
Cloudflare Worker (workers.dev)
  -> GatewayDurableObject
     -> Durable Object SQLite for task/auth/audit metadata
     -> R2 for large artifacts
     -> Kaggle HTTP API via fetch()
     -> outbound-only WebSocket Local Agent on Windows
     -> durable Chat Swarm / Browser Wake Bridge state
```

Do **not** deploy the vNext gateway through Tailscale Funnel, Cloudflare Quick Tunnel, Fly.io, Render, Railway, or an inbound Windows port. The old Quick Tunnel is legacy fallback only and must remain available until the new ChatGPT connector passes real end-to-end validation.

Free-tier usage can keep fixed infrastructure cost at or near zero for light workloads, but this is not a permanent cost guarantee; Cloudflare/Kaggle quotas and pricing can change.

## Required Cloudflare resources

`wrangler.toml` expects:

- Worker name: `devspace-ultra-gateway`
- Durable Object binding: `GATEWAY_DO`
- Durable Object SQLite class: `GatewayDurableObject`
- R2 binding: `ARTIFACTS_R2`
- R2 bucket: `devspace-ultra-artifacts`
- `nodejs_compat`

Create the R2 bucket once if it does not already exist:

```powershell
npx wrangler r2 bucket create devspace-ultra-artifacts
```

Do not recreate or delete an existing production bucket during routine deployment.

## Required production secrets

Set Worker runtime secrets with Wrangler; never commit them to GitHub, `wrangler.toml`, logs, screenshots, or chat messages.

```powershell
npx wrangler secret put MASTER_SECRET
npx wrangler secret put KAGGLE_API_TOKEN
```

`MASTER_SECRET` must be at least 32 characters and should be high entropy.

`KAGGLE_API_TOKEN` should contain the Kaggle credential JSON expected by the gateway. `KAGGLE_USERNAME` + `KAGGLE_KEY` are supported as an alternative, but production should use Cloudflare Secrets rather than checked-in configuration.

The Worker has a safe default public base URL for the current deployment. If a different production hostname is used, configure `PUBLIC_BASE_URL` to the exact HTTPS origin and verify all OAuth metadata/resources use the same origin.

GitHub Actions requires two repository secrets for non-interactive Wrangler authentication:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Create an account-owned Cloudflare API token using the `Edit Cloudflare Workers` policy and scope it only to the account/resources required by this Worker. The workflow normalizes embedded CR/LF characters before placing the token in an HTTP Authorization header, verifies the token against `GET /accounts/{account_id}/tokens/verify`, and only then proceeds to deployment. Do not use `wrangler whoami` as the account-token preflight because that command may use user-token identity endpoints. Secret values must never be printed or committed.

## CI and automatic production deployment

`feature/vnext-remote-gateway` is the current vNext production branch.

A push that changes `vnext/**` or `.github/workflows/vnext-ci.yml` runs the following gated workflow:

1. `npm install --ignore-scripts --no-audit --no-fund`
2. `npm run build`
3. `npm test`
4. `npx wrangler deploy --dry-run`
5. only if every verification step passes, authenticate to Cloudflare and run `npx wrangler deploy`
6. run production smoke checks against `https://devspace-ultra-gateway.abdul-hsu.workers.dev`

Pull requests run verification and dry-run only. They never deploy production.

Production deployment must target the existing `devspace-ultra-gateway` configured by `vnext/wrangler.toml`. Routine CI deployment must not create a second Worker, recreate the Durable Object, recreate the R2 bucket, or modify production secrets.

A vNext production-affecting change is **not complete** merely because the source was pushed or CI tests passed. It is complete only after the production deploy job and its smoke checks are green.

The production deployment job is serialized with GitHub Actions concurrency so two vNext deploys cannot race each other.

## Manual build / recovery deployment

Use manual deployment only for recovery, investigation, or when GitHub Actions is unavailable. Run from the `vnext` directory:

```powershell
npm install
npm run build
npm test
npx wrangler deploy --dry-run
npx wrangler deploy
```

Deployment must not proceed if TypeScript, tests, or the Wrangler dry-run fail.

After a manual deployment, run the same production endpoint checks described below. Do not report the rollout as complete until those checks pass.

## Production endpoint checks

Expected public endpoint:

```text
https://devspace-ultra-gateway.abdul-hsu.workers.dev
```

Check the minimal public health endpoint:

```powershell
Invoke-RestMethod https://devspace-ultra-gateway.abdul-hsu.workers.dev/health
```

Expected response:

```json
{"ok":true}
```

OAuth discovery must return HTTP 200:

```text
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

The protected-resource metadata must advertise the scopes required by the live connector, including `local:read` and `local:write` while local write tools remain supported.

The MCP resource itself must reject an unauthenticated request with HTTP 401 and a `WWW-Authenticate` header pointing at the protected-resource metadata. Do not weaken `/mcp` to anonymous access for smoke testing.

The automatic production workflow verifies all of the checks above after every successful deployment.

## ChatGPT OAuth connector

Create the new connector in parallel with the legacy connector.

```text
Name: DevSpace Ultra vNext
Server URL: https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp
Authentication: OAuth
Advanced OAuth settings: leave default
```

The gateway supports OAuth discovery, public PKCE S256 clients, Dynamic Client Registration for ChatGPT compatibility, refresh-token rotation, resource binding, and least-privilege scopes.

The normal ChatGPT OAuth grant must not contain `admin:*`.

After authorization, ChatGPT must successfully discover the tool catalog and call at least:

- `kaggle_run`, `kaggle_status`, `kaggle_logs`, `kaggle_result`
- `remote_task_submit`, `remote_task_status`
- core `chat_swarm_*` tools

If production OAuth scopes change, an already-connected ChatGPT connector may need OAuth reauthorization before it receives the new scopes.

## Windows Local Agent

The Windows agent initiates the connection. Do not expose an inbound Windows port.

Target WebSocket URL:

```text
wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent
```

Use a device credential scoped only to the Local Agent. Device secrets remain on the Windows host and must not be copied into ChatGPT OAuth configuration.

## Browser Chat Swarm

The Cloudflare-native compatibility endpoints are:

```text
/chat-swarm/browser-bind
/chat-swarm/browser-bind-invite
/chat-swarm/browser-direct-join
/chat-swarm/browser-claim
/chat-swarm/browser-events
/chat-swarm/worker-events
```

Browser wake tokens and worker tokens are separate private credentials. Browser/Worker event streams use those credentials and do not require a public inbound Windows listener.

## Cutover rule

Do not remove the legacy `DevSpace Ultra` connector and do not stop the old Quick Tunnel until all of the following have passed from an actual ChatGPT conversation:

1. OAuth authorization and tool refresh.
2. `kaggle_*` private CPU smoke task through the new connector.
3. `remote_task_*` local safe task through the outbound Windows Agent.
4. Browser/Worker Chat Swarm smoke flow.
5. Required legacy workflows have either been migrated or explicitly retained on the old connector.

Only after those checks pass may the old connector/tunnel be retired.
