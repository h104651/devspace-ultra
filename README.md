# DevSpace Ultra (v2.0)

**Secure ChatGPT Remote Tool Gateway + Outbound Local Agent + Kaggle Backend + Durable Task System**

DevSpace Ultra v2.0 provides a hardened, zero-trust remote execution platform connecting ChatGPT / Remote Agents to local Windows workstations and remote Kaggle Free GPU clusters without exposing home networks, without inbound open ports, and with persistent, durable task management.

---

## Key Architecture Principles

1. **Zero Inbound Ports on Local Machines**: The Windows Local Agent operates **outbound-only** via secure WebSockets (`wss://` / `ws://`).
2. **Independent Kaggle GPU Backend**: Run long-running AI/ML training and inference directly on Kaggle Free GPU/CPU without needing the local machine online.
3. **Durable & Resilient Task Management**: Tasks persist to disk across ChatGPT turn boundaries, disconnections, client refreshes, and worker crashes.
4. **Zero-Trust Security & Scope Isolation**: Granular permissions (`kaggle:submit`, `local:read`, `local:write`, `local:test`, `swarm:dispatch`, `admin`). Raw shell is strictly disabled by default.
5. **Prompt-Injection Resistance**: Content from repositories, web pages, or Kaggle outputs cannot escalate permissions or execute unauthorized actions.
6. **Chat Swarm & Wake Bridge**: Full support for worker dispatch, role claiming, task acknowledgements, worker recycling, and event pumping.

---

## High-Level Topology

```text
 ChatGPT / Remote Agent
           |
           v (HTTPS / MCP)
 +-------------------------------+
 |  DevSpace Ultra Gateway       |
 |  - Zero-Trust Token Auth      |
 |  - Durable Task Store (ACID)  |
 |  - Stale Lease Recovery       |
 |  - Audit Logger & Redactor    |
 +---------------+---------------+
                 |
        +--------+--------+
        |                 |
        v                 v
 +---------------+ +-------------------------------+
 | Kaggle Backend| | Local Windows Agent           |
 | (Kaggle CLI / | | (Outbound-only WebSocket)     |
 | Free GPU T4)  | | - High-level safe executors   |
 | - Async Push  | | - Heartbeat & lease renewal   |
 | - Auto Poller | | - Git / Tests / Build / Files |
 | - Artifacts   | +-------------------------------+
 +---------------+
```

---

## Quick Start

### 1. Installation
```bash
git clone <repo-url> devspace-ultra
cd devspace-ultra
npm install
npm run build
```

### 2. Start the Gateway
```bash
npm run gateway
```
*When first run, the gateway automatically generates an Admin Client Token and an Initial Device Token.*

### 3. Start the Local Outbound Agent (on Windows)
Configure `.env`:
```env
GATEWAY_URL=ws://localhost:4000/ws/agent
AGENT_ID=desktop-windows-primary
AGENT_TOKEN=<your-device-token>
ALLOWED_WORKSPACES=C:\Users\testuser\Desktop\Golf app
ALLOW_RAW_SHELL=false
```
Then start the agent:
```bash
npm run agent
```

### 4. Connect with ChatGPT via MCP
Configure your MCP Client:
```json
{
  "mcpServers": {
    "devspace-ultra": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "env": {
        "PORT": "4000",
        "STORAGE_DIR": ".devspace-storage"
      }
    }
  }
}
```

---

## MCP Tools Overview

| Tool Name | Scope Required | Description |
|---|---|---|
| `kaggle_run` | `kaggle:submit` | Submit code/notebook to Kaggle Free GPU asynchronously |
| `kaggle_status` | `kaggle:read` | Query status of Kaggle execution (`queued`, `running`, `complete`, `error`) |
| `kaggle_logs` | `kaggle:read` | Fetch stdout/stderr logs from Kaggle job |
| `kaggle_result` | `kaggle:read` | Retrieve final metrics and artifacts from Kaggle |
| `remote_task_submit` | *Dynamic* | Submit durable task across backends (`kaggle`, `local`, `swarm`, `browser`) |
| `remote_task_status` | `local:read` | Query lifecycle state and output of any task |
| `remote_task_logs` | `local:read` | Stream execution logs in real-time |
| `remote_task_artifacts` | `local:read` | List and inspect generated artifacts |
| `remote_task_cancel` | `local:write` | Cancel active or queued task |
| `swarm_dispatch` | `swarm:dispatch` | Dispatch instruction to Chat Swarm worker with automated claim/ack |
| `swarm_status` | `swarm:dispatch` | List active workers and task assignments |
| `device_status` | `admin` | Inspect online status and capabilities of local agents |
| `kill_switch_trigger` | `admin` | Instant revocation of devices or global emergency stop |

---

## Automated Test Suite

Run the full automated test suite:
```bash
npm test
```
*Executes all 49 unit, integration, and security test cases.*

---

## Documentation Index

- [Architecture & Data Flow](docs/ARCHITECTURE.md)
- [Security & Zero-Trust Model](docs/SECURITY.md)
- [Threat Model & Injection Defense](docs/THREAT_MODEL.md)
- [Kaggle Backend Guide](docs/KAGGLE.md)
- [Durable Task Lifecycle](docs/REMOTE_TASKS.md)
- [Zero-Cost Cloud Deployment](docs/DEPLOYMENT.md)
- [Troubleshooting & Diagnostics](docs/TROUBLESHOOTING.md)
- [Migration from Legacy Bridge](docs/MIGRATION.md)
