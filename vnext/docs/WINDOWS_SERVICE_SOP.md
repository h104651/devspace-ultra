# DevSpace Ultra vNext — Windows Agent Permanent Service SOP

## 1. Architecture Overview

The standardized Windows Local Agent service uses native Windows and Node.js primitives with **zero external service wrappers (no NSSM/WinSW)** and **zero hardcoded usernames or installation paths**:

```text
Windows Task Scheduler (DevSpaceUltra_LocalAgent, LogonTrigger +10s, Interactive, Limited)
  └─ wscript.exe scripts\windows\launch-daemon.vbs (windowless, propagates exit code)
       └─ node.exe scripts\windows\agent-daemon.js (supervisor, log rotation, authenticated IPC)
            └─ node.exe dist\cli\agent-cli.js (outbound WebSocket worker + exclusive device lock)
```

### Key Guarantees
1. **Release & Config Directory Separation**: Code lives in an immutable release directory (`DEVSPACE_RELEASE_DIR`); `.env`, `projects.json`, and `logs\` can live in an independent configuration directory (`DEVSPACE_CONFIG_DIR`).
2. **Least-Privilege Child Environment**: `agent-daemon.js` constructs a strict allowlist environment for `agent-cli.js` (essential Windows runtime vars + Agent config keys). Administrative and cloud credentials (`ADMIN_SECRET`, `MASTER_SECRET`, `CLIENT_TOKEN`, `CLOUDFLARE_API_TOKEN`, `KAGGLE_KEY`, etc.) are stripped from both daemon child env and worker `process.env`.
3. **Authenticated Local IPC Shutdown (Windows ACL verification pending)**:
   - Each daemon generates a per-launch random `ipcSecret` stored with requested POSIX `0o600` permissions (not a Windows DACL guarantee) in `%USERPROFILE%\.devspace-ultra\agent-control\<sha256(deviceId)>.control.json`.
   - `ipc-control.js` / `stop-agent.ps1` only accepts `STATUS` and `SHUTDOWN` actions authenticated with `crypto.timingSafeEqual` and matching `deviceId`. Arbitrary command execution is rejected (`FORBIDDEN_ACTION`).
   - On `SHUTDOWN`, the daemon immediately disables auto-restart, instructs `agent-cli.js` over private parent-child Node IPC to stop polling, drain active tasks within `timeoutMs`, close WebSocket (`1000`), and release `.lock` only when idle.
4. **Fail-Closed Exit Codes & Task Scheduler Coordination**:
   - `0` (`CLEAN_STOP`), `10` (`CONFIG_ERROR`), `11` (`LOCK_CONFLICT`), `12` (`POLICY_REJECTED`), `13` (`SHUTDOWN_TIMEOUT_LOCK_RETAINED`) are non-retryable.
   - `agent-daemon.js` halts auto-restart on non-retryable exit codes or after a bounded lifetime restart budget (`maxRapidRestarts = 5`) and exits `0`, preventing Windows Task Scheduler `RestartOnFailure` from looping past fail-closed guards.
   - Residual `.lock` files are **never** automatically deleted.
5. **Log Rotation & Redaction**:
   - Writes to `<logDir>\agent-daemon.log`, rotating at `10 MB` (`maxLogFiles = 5`, keeping `.1`..`.5`), with automatic secret/token redaction.
6. **Optional Display Name**:
   - Set `AGENT_NAME=<Display Name>` in `.env` (or `--name`) to customize display name without modifying `AGENT_ID`. Defaults to `Local-Agent-<hostname>`.

---

## 2. Standard Directory Layout (Workstation 1 & Node2)

- **Release Directory** (`<ReleaseDir>`):
  - `%LOCALAPPDATA%\devspace-ultra-<commit-sha>` (clean Git checkout of target `main` SHA, built via `npm ci --ignore-scripts --no-audit --no-fund`)
- **Config Directory** (`<ConfigDir>`, kept out of Git):
  - Contains `.env`, `projects.json`, and `logs\`
  - Minimal `.env` template:
    ```env
    GATEWAY_URL=wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent
    AGENT_ID=<device-id>
    AGENT_NAME=<optional-display-name>
    AGENT_TOKEN=<device-token>
    LOCAL_PROJECTS_CONFIG=projects.json
    ALLOW_RAW_SHELL=false
    ```
- **Launcher Configuration** (`<ReleaseDir>\vnext\scripts\windows\service-config.json`, gitignored):
  ```json
  {
    "releaseDir": "C:\\Users\\<user>\\AppData\\Local\\devspace-ultra-<sha>\\vnext",
    "configDir": "C:\\Users\\<user>\\AppData\\Local\\devspace-ultra-config",
    "logDir": "C:\\Users\\<user>\\AppData\\Local\\devspace-ultra-config\\logs",
    "maxLogBytes": 10485760,
    "maxLogFiles": 5,
    "maxRapidRestarts": 5,
    "shutdownTimeoutMs": 10000
  }
  ```

---

## 3. Workstation Deployment SOP

### Workstation 1 (`win11-arm64-workstation`)
1. Deploy clean release directory at target `main` SHA (`npm ci --ignore-scripts --no-audit --no-fund`).
2. Place `win11-arm64-workstation` `.env` (without `ADMIN_SECRET` / `MASTER_SECRET` / `CLIENT_TOKEN`, `ALLOW_RAW_SHELL=false`) and 6-project `projects.json` in Config Directory.
3. Configure `service-config.json` in `vnext\scripts\windows\`.
4. Register scheduled task:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\register-agent-task.ps1"
   ```
5. Start and verify:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\start-agent.ps1"
   powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\check-status.ps1"
   ```

### Workstation 2 (`win11-arm64-node2`, Read-Only)
1. Deploy clean release directory at same target `main` SHA (`npm ci --ignore-scripts --no-audit --no-fund`).
2. Place `win11-arm64-node2` `.env` (read-only Device Token, `AGENT_ID=win11-arm64-node2`, optional `AGENT_NAME=Win11-ARM64-Node2`, `ALLOW_RAW_SHELL=false`) and 2-project `projects.json` (`read: true`, `write: false`, `test: false`, `build: false`, `hostExecution: false`) in Node2 Config Directory.
3. Configure `service-config.json` in `vnext\scripts\windows\` pointing to Node2 `releaseDir` and `configDir`.
4. Register scheduled task and start:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\register-agent-task.ps1"
   powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\start-agent.ps1"
   powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\check-status.ps1"
   ```

---

## 4. Operations, Graceful Stop & Safe Rollback

### Graceful Stop
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<ReleaseDir>\vnext\scripts\windows\stop-agent.ps1"
```
- Uses authenticated IPC (`ipc-control.js shutdown`) to drain tasks, close WebSocket (`1000`), release `.lock`, and stop the daemon cleanly.
- The stop script refuses wildcard process termination, and does not stop an unverified scheduled task. ForceOnTimeout is intentionally fail-closed pending independently verified target-specific recovery.
- If `stop-agent.ps1` reports exit code `13` (`AUDIT_REQUIRED`) or timeout with retained `.lock`:
  1. Verify via `check-status.ps1` / `Get-CimInstance Win32_Process` that `agent-cli.js` and child processes have fully exited.
  2. Reconcile any uncertain tasks on the Gateway before manually removing `%USERPROFILE%\.devspace-ultra\agent-locks\<hash>.lock`.

### Safe Rollback
1. Run `stop-agent.ps1` and verify zero residual processes and released lock.
2. Update `service-config.json` (`releaseDir`) back to the previous clean release directory (keeping `configDir` intact).
3. Run `start-agent.ps1` and verify via `check-status.ps1` that PID, Lock ownership, and WebSocket connectivity are healthy.
