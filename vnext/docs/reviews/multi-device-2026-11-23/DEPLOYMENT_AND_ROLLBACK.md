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

## 三、正式部署實施步驟 (Formal Deployment Sequence)

正式上線嚴格遵守十階段防護門禁序列 (A ~ J)，禁止跨階段執行：

### 階段 A：最新 PR CI PASS
- GitHub Actions 之 `CI` 與 `vNext CI & Production Deploy`（驗證階段）全數通過（含 TypeScript Build、全量測試與 Wrangler Dry Run）。

### 階段 B：驗證 Deployment Gate 已阻止未授權正式部署
- 確認 `.github/workflows/vnext-ci.yml` 門禁生效：普通 Push 至 `main` 或 PR Merge 絕不觸發 `deploy-production`。
- 正式部署必須透過手動 `workflow_dispatch`，且嚴格要求在 `refs/heads/main`、`deploy_production == true`、`preflight_inventory_confirmed == true` 並校驗 `target_commit_sha`。

### 階段 C：取得正式環境完整唯讀盤點及遷移風險報告
- 在維護窗口內，由持有正式 `ADMIN_SECRET` 之運維人員執行唯讀任務盤點：
  ```bash
  npm run inventory:tasks -- --gateway-url https://devspace-ultra-gateway.abdul-hsu.workers.dev --admin-secret "$PROD_ADMIN_SECRET"
  ```
- 或透過 Cloudflare Wrangler 直接執行唯讀 SQL 查詢：
  ```bash
  npx wrangler durable-objects sql query DEVSPACE_GATEWAY_DO \
    "SELECT taskId, status, backend, targetDeviceId, leaseJson, attemptsJson FROM tasks WHERE status IN ('queued', 'claimed', 'running', 'retrying')"
  ```
- 確認是否有懸空未指派（quarantined）任務；若有，必須透過 `POST /admin/tasks/assign-legacy` 指定目標裝置，或等待其執行完成。未完成盤點前，正式部署標記為 **NO-GO**。

### 階段 D：確認舊 Windows Bootstrap Token、裝置身分及任務擁有權相容性
- 確認舊電腦 `win11-arm64-workstation` 之 Bootstrap Token 在升級後無縫相容。
- **嚴格禁止透過 `POST /admin/devices` 重新簽發或註冊舊電腦**，避免造成 `TOKEN_SUPERSEDED` 導致舊 Agent 斷線。

### 階段 E：經使用者明確核准才 Merge PR #23
- 取得工程師與主管明確核准後，將 PR #23 合併至 `main`。
- 此時 GitHub Actions 僅執行驗證流程，不會部署生產環境。

### 階段 F：維護窗口內經獨立授權執行唯一一次正式部署
- 在維護窗口期間，授權人員前往 GitHub Actions 手動觸發 `vNext CI & Production Deploy`，提供：
  - `deploy_production`: `true`
  - `preflight_inventory_confirmed`: `true`
  - `target_commit_sha`: `<MERGED_MAIN_SHA>`
  - `operator_name`: `<OPERATOR_ID>`
- 執行單次正式部署。

### 階段 G：驗證既有 Windows Agent 正常在線
- 部署完成後，確認舊電腦 `win11-arm64-workstation` WebSocket 連線正常，健康檢查通過：
  ```powershell
  Invoke-RestMethod https://devspace-ultra-gateway.abdul-hsu.workers.dev/health
  # 回傳 { "ok": true }
  ```

### 階段 H：確認資料庫遷移與舊任務狀態正確
- Durable Object 啟動水合時自動完成 `activeTokenId` 欄位增補。
- 歷史有 Claimant 之任務自動保留原目標裝置；無 Claimant 任務維持隔離佇列，絕不發生跨電腦錯派。

### 階段 I：核發新 Windows 最小唯讀 Token，啟動第二台 Agent
- 透過受保護管理介面註冊新電腦，嚴格限定最小唯讀權限：
  ```bash
  curl -X POST https://devspace-ultra-gateway.abdul-hsu.workers.dev/admin/devices \
    -H "Content-Type: application/json" \
    -H "X-Admin-Secret: <PROD_ADMIN_SECRET>" \
    -d '{
      "name": "New Windows Workstation",
      "platform": "windows",
      "deviceId": "win11-arm64-workstation-2",
      "capabilities": ["local:read", "artifacts:read"]
    }'
  ```
- 在新電腦設定環境變數並啟動 Agent：
  ```powershell
  $env:GATEWAY_URL = "wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent"
  $env:AGENT_ID = "win11-arm64-workstation-2"
  $env:AGENT_TOKEN = "<NEW_DEVICE_TOKEN>"
  $env:ALLOW_RAW_SHELL = "false"
  node dist/cli/agent-cli.js --projects-config "$HOME\DevSpace\agent-config\projects.json"
  ```

### 階段 J：完成雙電腦唯讀端到端驗收
- 透過 MCP 呼叫 `device_status`，確認雙裝置均在線。
- 分別提交指定各裝置之唯讀任務，確認定向路由 100% 正確。

---

## 四、正式環境歷史任務安全升級與舊 Agent 相容性報告

### 1. 部署前唯讀任務盤點設計與狀態 (Pre-Deployment Read-Only Task Inventory)
- **盤點工具與腳本**: 專案已建立實際可執行之盤點腳本 `vnext/scripts/inventory-tasks.ts`（可透過 `npm run inventory:tasks` 執行）。
- **盤點安全保證**:
  - **嚴格唯讀**: 僅查詢 `tasks` 資料表，絕不觸發 Migration、Claim、Reopen 或 Recovery。
  - **敏感資訊脫敏**: 絕不輸出 Payload 內之程式碼、機密字串或 Token。
  - **分頁與全量支援**: 支援 `limit` 與 `offset`，杜絕單頁 100 筆之靜默截斷。
  - **明確 Exit Codes**:
    - `0`: SUCCESS / READY（所有任務皆有明確目標裝置，無懸空任務）。
    - `1`: ERROR（網路錯誤或認證失敗）。
    - `2`: BLOCKED / MANUAL_REVIEW_REQUIRED（存在 quarantined 任務或未提供正式金鑰）。
- **預檢現況判定**: **PRODUCTION PREFLIGHT BLOCKED**。
  - 因本機環境未持有正式環境 `ADMIN_SECRET`，查詢遠端 Gateway 遭阻擋。
  - **嚴禁假設正式環境任務為零**，正式部署前必須在維護窗口由運維人員實際執行此腳本或直接 SQL 查詢盤點。

### 2. 歷史未完成任務遷移安全性 (Zero Task Loss & No Automatic Binding)
針對正式 SQLite 中可能存在的未完成任務（Queued、Claimed、Running、Retrying）：
- **存在歷史 Claimant 的任務**:
  - `TaskStore.migrateLegacyUnassignedTasks` 會依序檢查 `task.lease?.claimedBy` 與 `task.attempts` 中的歷史認領者。
  - 一旦存在歷史 Claimant，**即便系統當前 0 台裝置在線，亦無條件保留並綁定回原目標電腦 (`win11-arm64-workstation`)**。
  - 任務不會被改派，也不會轉為失敗。
- **無歷史 Claimant 的歷史任務 (Quarantined Tasks)**:
  - **嚴禁自動綁定第一台連線裝置**: 不論舊電腦或新電腦誰先連線，連線本身**絕不構成任務擁有權之證明**。
  - 未經證明的歷史任務在冷啟動與連線後，一律安全保留在 `status: 'queued'` 且 `targetDeviceId: undefined` 的隔離狀態。
  - 因 `claimTask` 與 `claimTaskById` 嚴格要求本地任務之 `targetDeviceId === deviceId`，任何 Agent（包含新舊電腦）均無法領取此任務，徹底杜絕跨裝置搶單或錯派。
  - **管理員核准指派機制**: 管理員於盤點確認後，可呼叫受保護端點 `POST /admin/tasks/assign-legacy`，指定合法裝置 ID（如 `win11-arm64-workstation`），受管指派後原舊 Agent 即可安全領取執行。
  - 系統絕不無條件刪除或將未綁定任務標記為失敗，達成真正零任務遺失。

### 3. 舊電腦正式狀態 (`totalRegistered: 0 / totalOnline: 1`) 與嚴禁補登說明
- **根本原因深入分析**：
  - 在 PR #23 之前，Gateway 並無 `/admin/devices` 動態註冊介面。舊電腦（`win11-arm64-workstation`）採用初始啟動模式，其 Agent Token 是由管理者直接使用 `MASTER_SECRET` 以 HMAC-SHA256 簽署產生的 Bootstrap Token。
  - 舊版 Gateway 未在 Cloudflare DO SQLite 的 `devices` 表中寫入記錄，因此 `authManager.listDevices()` 回傳空陣列（`totalRegistered: 0`）。
  - 當舊電腦 Agent 建立 WebSocket 連線時，`AuthManager.validateToken` 使用 `MASTER_SECRET` 驗證其 HMAC 簽名成功，連線被 `ConnectionManager` 正常收錄並維持心跳（`totalOnline: 1`）。
- **【嚴正警告】嚴禁使用 `POST /admin/devices` 補登舊電腦 ID**:
  - 經單元與整合測試證實（詳見 `Task B16`）：
    1. 若對已在線的舊電腦 ID 調用 `POST /admin/devices`，系統將因 ID 存在而拋出 `DEVICE_ID_CONFLICT`。
    2. 若先將舊電腦撤銷再重新註冊，系統將會為其生成全新的 `activeTokenId`。此時舊電腦現有的 Bootstrap Token 在重新連線時將被判定為 `TOKEN_SUPERSEDED`，導致**舊電腦永久無法連線**！
- **正確相容流程 (Zero-Interruption SOP)**:
  - **完全不需對舊電腦執行任何註冊操作**。
  - 舊電腦持續使用既有 Bootstrap Token 保持連線。
  - 部署新版 Gateway 後，舊電腦重連時會由 Gateway 呼叫 `rememberAuthenticatedDevice`，自動收錄進 SQLite `devices` 表，舊憑證完全不受影響。

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
