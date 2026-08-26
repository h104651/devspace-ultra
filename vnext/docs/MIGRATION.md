# DevSpace Ultra — Migration from Legacy Bridge Architecture

## 1. Summary of Architectural Differences

| Feature | Legacy DevSpace (v1.x) | DevSpace Ultra (v2.0) |
|---|---|---|
| **Connection Model** | Inbound tunnel to local PC (ngrok / Cloudflare Tunnel) | Outbound-only WebSocket from local PC to secure Gateway |
| **IP / Tunnel Dependency** | Fragile; broke on IP change or tunnel restart | Resilient; fixed Gateway endpoint with automatic reconnect |
| **Kaggle Execution** | Synchronous blocking HTTP request tied to local machine | Asynchronous Kaggle API runner with independent background polling |
| **Task Persistence** | In-memory only (lost on process restart) | File-backed ACID Durable Task Store with leases and stale recovery |
| **Security & Auth** | Single shared static secret or unauthenticated | Zero-Trust HMAC tokens, granular scopes, secret redactor, kill switch |
| **Shell Access** | Unrestricted arbitrary shell | High-level capability actions; raw shell disabled by default |
| **Multi-Worker Swarm** | Basic polling | Full Chat Swarm coordinator + Wake Bridge event pump |

---

## 2. Migration Checklist

1. **Retire Old Inbound Tunnels**:
   - Stop ngrok, Cloudflare Tunnel, or port forwarding services pointed at your local PC.
2. **Deploy Gateway**:
   - Host DevSpace Ultra Gateway on a stable cloud endpoint or local LAN server (`npm run gateway`).
3. **Configure Local Windows Agent**:
   - Register a device token using the Gateway CLI.
   - Run `npm run agent` on the Windows machine.
4. **Update ChatGPT / MCP Configuration**:
   - Point ChatGPT or MCP Client to the new DevSpace Ultra MCP server or REST endpoints with the issued client Bearer token.
