# DevSpace Ultra vNext — Production Architecture

## 1. Overview

DevSpace Ultra vNext provides a stable public MCP/OAuth endpoint for ChatGPT without exposing the Windows workstation to inbound Internet traffic.

```text
ChatGPT
  -> HTTPS + OAuth 2.1 + MCP
Cloudflare Worker
  -> singleton GatewayDurableObject
     -> Durable Object SQLite
        - tasks
        - idempotency records
        - OAuth clients/codes
        - revocation/audit metadata
        - artifact metadata
     -> Durable Object key/value + alarms
        - Chat Swarm compatibility state
        - Kaggle poll schedule
     -> R2
        - large/binary artifact payloads
     -> Kaggle HTTP API (fetch only)
     -> outbound-only WSS Windows Local Agent
```

The production endpoint is a fixed `workers.dev` origin. Tailscale Funnel, Cloudflare Quick Tunnel, ngrok, and public inbound Windows ports are not part of the vNext production path.

## 2. Request flow

### ChatGPT MCP

1. ChatGPT discovers OAuth metadata from the Worker.
2. ChatGPT dynamically registers a public PKCE client when required by the current ChatGPT integration.
3. User authorization produces a least-privilege OAuth grant.
4. ChatGPT calls `/mcp` with an access token bound to the MCP resource.
5. The GatewayDurableObject validates token purpose, resource, revocation state, scopes, and MCP protocol metadata.
6. The requested tool routes to Kaggle, the Windows Local Agent, or the durable Chat Swarm coordinator.

The modern MCP path supports the `2026-07-28` wire protocol while retaining bounded compatibility for supported 2025-era clients.

## 3. Cloudflare Worker and Durable Object

`src/cloudflare/worker.ts` performs only edge routing. All Gateway traffic is forwarded to one named `GatewayDurableObject`, giving the system one serialized coordination authority without opening a local server.

The Durable Object owns:

- MCP and REST request handling.
- OAuth authorization-server and protected-resource endpoints.
- WebSocket acceptance for outbound Windows Local Agents.
- Durable task routing and stale recovery.
- Kaggle Durable Object alarm scheduling.
- Browser/Worker Chat Swarm event streams.
- Artifact authorization and metadata lookup.

## 4. Durable storage

### Durable Object SQLite

`CloudflareSqliteStorageAdapter` is the authoritative persistent store for durable task/auth/audit metadata. The in-memory stores hydrate from SQLite after a Durable Object instance starts and persist mutations back through the adapter.

This replaces the early vNext file-backed/in-memory production design.

### Durable Object key/value storage

Small coordinator state that belongs to the singleton object is stored in Durable Object storage, including:

- `devspace:chat-swarm-compat:v1`
- pending Kaggle poll records used by the DO alarm scheduler

The Chat Swarm state therefore survives Durable Object instance replacement.

### R2

Large/binary artifact payloads are stored in the `ARTIFACTS_R2` bucket. Durable Object/SQLite state contains metadata and small previews rather than large binaries.

## 5. Kaggle backend

Production Kaggle execution is Cloudflare-compatible and uses `fetch()` HTTP requests only. It must not depend on:

- local Python execution
- local Kaggle CLI
- `child_process`
- executable files on the Worker filesystem

A submitted Kaggle task receives a durable task ID. Poll scheduling is persisted and armed with a Durable Object alarm. A fresh Durable Object instance can continue polling after eviction/restart.

## 6. Windows Local Agent

The Windows Local Agent initiates an outbound WebSocket connection to:

```text
wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent
```

No inbound Windows listener is required.

The Local Agent executes capability-restricted operations. Safe read/test operations can be granted to the normal ChatGPT OAuth client without granting arbitrary shell or administrative capabilities.

Windows-specific legacy ChatGPT Classic runtime/update automation is not executed inside Cloudflare Workers. Those operations require an explicit Local Agent capability before they can be migrated safely.

## 7. OAuth and authorization

The normal ChatGPT OAuth client is limited to:

```text
offline_access
mcp:access
tasks:submit
tasks:read
artifacts:read
kaggle:submit
kaggle:read
local:read
local:test
swarm:dispatch
```

No `admin:*` scope belongs in the normal ChatGPT grant.

OAuth protections include:

- PKCE S256
- Dynamic Client Registration compatibility
- exact registered redirect URI validation
- RFC 8707 resource binding
- access-token vs refresh-token purpose separation
- refresh-token rotation/revocation
- unsupported-only scope request rejection
- protected-resource metadata and `WWW-Authenticate` challenge

Administrative kill-switch/revocation privileges use a separate administrative credential.

## 8. Chat Swarm compatibility

Core legacy Chat Swarm coordination is implemented inside the Durable Object rather than proxied to an inbound Windows service.

Supported compatibility behavior includes:

- create/join/status/resize
- idempotent batch dispatch
- worker claim/ack/next/recover
- submit/submit-once/collect/cancel
- recycle/leave/close
- Browser Wake Bridge bind/direct-join/claim/events
- persistent Worker Dock event stream
- stable browser page worker identity
- offer leases that prevent a generic task waking multiple workers
- claimed-task replay after Durable Object replacement

Windows-only runtime lifecycle/update tools remain a separate migration concern because their legacy implementation invokes PowerShell/ChatGPT Desktop locally.

## 9. Security boundaries

ChatGPT input is untrusted. Tool arguments remain subject to scope checks, input validation, path restrictions, rate limits where applicable, audit logging, token revocation, and the global kill switch.

Secrets are Cloudflare Secrets or host-local credentials. They must never be stored in Git, emitted into MCP results, or written to diagnostic logs.

## 10. Cutover

The legacy connector and Quick Tunnel are retained during blue/green migration. They are retired only after an actual ChatGPT conversation successfully completes OAuth discovery, MCP tool discovery, a private Kaggle smoke task, a safe Local Agent task, and a Chat Swarm smoke flow through the new Worker endpoint.
