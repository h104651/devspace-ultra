# DevSpace Ultra vNext — 正式部署方案、安全前置檢查與緊急回復計畫

> **【注意】** 本文件為正式上線規劃指南。本輪開發與驗收**嚴禁執行真實部署**，一切變更必須待 ChatGPT 人工審查核准後，方可進入此 SOP。

---

## 一、現有正式架構與必須保留資源

- **正式 Cloudflare Worker 名稱**: `devspace-ultra-gateway`
- **正式 Gateway URL**: `https://devspace-ultra-gateway.abdul-hsu.workers.dev`
- **Agent WebSocket URL**: `wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent`
- **正式 Durable Object 名稱**: `GatewayDurableObject`（綁定為 `GATEWAY_DO`）
- **正式 R2 Bucket 名稱**: `devspace-ultra-artifacts`（綁定為 `ARTIFACTS_R2`）
- **既有線上 Agent 裝置**: `win11-arm64-workstation`（舊電腦）

### 必須保留與禁止觸碰資源
1. **禁止重建 Durable Object**: 嚴禁在 Cloudflare Dashboard 刪除或重設 Durable Object，以避免遺失歷史任務與審計日誌。
2. **禁止清空 R2 Bucket**: 歷史產出物與模型檔案必須完整保留。
3. **禁止重設 OAuth 授權**: 與 ChatGPT 現有的 OAuth 憑證與 Client ID/Secret 不得更動。
4. **禁止中斷舊電腦 Agent**: 舊電腦的 Local Agent 必須維持穩定在線，不受升級干擾。

---

## 二、部署前置檢查清單 (Pre-Deployment Checklist)

在將 PR 合併至 `main` 並觸發部署前，必須依序核對：

- [ ] **PR 審查核准**: ChatGPT 完成 GitHub PR 代碼與審查文件審查，且工程師手動核准。
- [ ] **GitHub CI 驗證通過**: `CI` 與 `vNext CI & Production Deploy` 中的 Verify 流程全數為綠燈 PASS。
- [ ] **Wrangler Dry Run 檢查無誤**: 本地及 CI 執行 `npx wrangler deploy --dry-run` 回傳 exit code 0，Binding 完整。
- [ ] **正式環境健康狀態確認**:
  ```powershell
  Invoke-RestMethod https://devspace-ultra-gateway.abdul-hsu.workers.dev/health
  # 必須回傳 { "ok": true }
  ```
- [ ] **確認不含機密檔案**: 工作區與 PR 內未包含 `.env`、正式憑證或真實 Token。

---

## 三、正式部署實施步驟 (Deployment SOP)

### 步驟 1：合併 Draft PR 至 `main`
- 將 PR #23 的 Draft 狀態轉為 Ready for Review。
- 採用 Squash and Merge 或 Rebase Merge 合併至 `main` 分支。
- GitHub Actions 自動觸發正式部署 Workflow。

### 步驟 2：監控生產環境 SQLite Schema 自動遷移
- Cloudflare Gateway Worker 部署完成後，第一個請求將喚醒 `GatewayDurableObject`。
- `CloudflareSqliteStorageAdapter` 會自動執行：
  ```sql
  ALTER TABLE devices ADD COLUMN activeTokenId TEXT;
  ```
- 既有 `devices` 記錄維持完整，水合過程自動完成舊任務遷移（`migrateLegacyUnassignedTasks`）。

### 步驟 3：透過受保護的管理介面註冊新電腦
使用受保護的管理密鑰向正式 Gateway 請求註冊新裝置：
```bash
curl -X POST https://devspace-ultra-gateway.abdul-hsu.workers.dev/admin/devices \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: <YOUR_ADMIN_SECRET>" \
  -d '{
    "name": "New Windows Workstation",
    "platform": "windows",
    "deviceId": "win11-arm64-workstation-2",
    "capabilities": ["local:read", "local:write", "local:test"]
  }'
```
- 若請求省略 `capabilities`，系統將預設為最小唯讀範圍 `["local:read", "artifacts:read"]`，絕不自動給予 `local:write`、`local:exec` 或 Raw Shell 權限。
- 回應標頭嚴格包含 `Cache-Control: no-store` 與 `Pragma: no-cache`，防止 Token 在代理伺服器或快取中洩漏。
- 記錄回傳之一次性 `token`，妥善存入新電腦本機環境變數或啟動腳本。
- 確認日誌中無明文 Token 殘留。

### 步驟 4：在新電腦啟動第二台 Local Agent
在 `agent-cli.ts` 規格中，認證連線參數由環境變數讀取，專案設定檔透過 `--projects-config` 指定。請在新 Windows 電腦以 PowerShell 執行：
```powershell
# 1. 切換至 vnext 目錄
cd C:\Users\testuser\DevSpace\devspace-ultra\vnext

# 2. 設定連線認證與安全變數
$env:GATEWAY_URL = "wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent"
$env:AGENT_ID = "win11-arm64-workstation-2"
$env:AGENT_TOKEN = "<NEW_DEVICE_TOKEN>"
$env:ALLOW_RAW_SHELL = "false"

# 3. 啟動 Outbound Local Agent
node dist/cli/agent-cli.js start --projects-config "$HOME\DevSpace\agent-config\projects.json"
```

### 步驟 5：雙 Agent 同時在線驗收
透過 MCP 調用 `device_status`，確認：
- `totalConnections: 2`
- `win11-arm64-workstation` 狀態為 `online`。
- `win11-arm64-workstation-2` 狀態為 `online`。
- 分別提交各指定一台電腦的讀取任務，確認任務精準送達各自專案目錄，無跨電腦錯配。

---

## 四、特別調查報告：正式環境裝置狀態差異 (`totalRegistered: 0 / totalOnline: 1`)

在 ChatGPT 先前執行的獨立審查中，觀察到正式 Cloudflare Gateway 上 `device_status` 回傳：
`totalRegistered: 0, totalOnline: 1`。

### 1. 根本原因深入分析
- **歷史架構機制**：在本次 PR #23 之前，Gateway 並無 `/admin/devices` 動態註冊介面。舊電腦（`win11-arm64-workstation`）採用初始啟動模式，其 Agent Token 是由管理者直接使用 `MASTER_SECRET` 以 HMAC-SHA256 簽署產生的 Bootstrap Token。
- **資料表水合差異**：舊版 Gateway 未在 Cloudflare DO SQLite 的 `devices` 表中寫入記錄，因此 `authManager.listDevices()` 回傳空陣列（`totalRegistered: 0`）。
- **連線層驗證通過**：當舊電腦 Agent 建立 WebSocket 連線時，`AuthManager.validateToken` 使用 `MASTER_SECRET` 驗證其 HMAC 簽名成功，連線被 `ConnectionManager` 正常收錄並維持心跳，因此線上連線數為 1（`totalOnline: 1`）。
- **向下相容防護**：`McpHandlers.handleDeviceStatus`（第 1316-1332 行）具備向前容錯機制，會主動掃描 `ConnectionManager` 中在線但未在 `devices` 表中列出的裝置，將其列入狀態報告（標註 `isRegistered: false`）。

### 2. 本次升級對舊電腦的相容性保證
- **Token 仍然有效**：PR #23 的 Token 驗證機制保留了對 `MASTER_SECRET` 簽名 Token 的完整驗證相容性，部署新版 Worker **不會**中斷舊電腦的連線或使其 Token 失效。
- **補登建議（非強制）**：部署 PR #23 後，管理者亦可使用 `POST /admin/devices` 將舊電腦裝置 ID `win11-arm64-workstation` 正式登錄進 SQLite，屆時 `totalRegistered` 將正常計入該裝置。

---

## 四、緊急回復與回滾方案 (Rollback Plan)

若部署後發生非預期異常（如任務路由阻塞或 Agent 連線異常）：

### 1. 快速程式碼回滾
- 在 GitHub 上對 Merge Commit 執行 `Revert`，推播至 `main`。
- CI 將自動重新部署前一個穩定版本（Commit: `1a933d3`）。

### 2. 資料庫向後相容性分析
- 本次遷移僅在 `devices` 表中新增了 `activeTokenId TEXT` 欄位。
- 舊版程式讀取 SQLite `devices` 表時，採用具名欄位解析或忽略未知欄位，**額外增加的 `activeTokenId` 欄位不會造成舊版代碼拋錯或當機**。
- 回滾到舊版本 Worker 時，舊版仍可正常水合既有裝置資料，不會發生 Schema 衝突。

### 3. 不可逆資料保護原則
- **嚴禁在回滾時執行清空資料庫命令**。
- 若特定裝置異常，透過管理端直接將該裝置標記為 `revoked`，即可安全隔離，無須回滾整個系統。
