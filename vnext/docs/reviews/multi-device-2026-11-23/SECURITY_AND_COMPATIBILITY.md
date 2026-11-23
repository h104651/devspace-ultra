# DevSpace Ultra vNext — 資安架構、憑證管理與相容性分析

## 一、Device Token 與憑證安全架構

### 1. 最小權限分離 (Least Privilege Separation)
- **`MASTER_SECRET` (伺服端核心密鑰)**:
  - 僅留存於 Cloudflare Gateway Durable Object / Gateway Server 內部環境。
  - 用於衍生 HMAC 簽章密鑰，**嚴禁傳送至任何客戶端或 Local Agent**。
  - 嚴禁透過 HTTP 標頭傳入作為管理憑證（調用 `/admin/*` 時若傳入 `MASTER_SECRET` 將被回傳 403 Forbidden 拒絕）。
- **`ADMIN_SECRET` (管理員操作專用密鑰)**:
  - 唯有具備 `ADMIN_SECRET` 的受信任管理流程方可調用 `POST /admin/devices` 簽發裝置憑證。
- **Device Token (裝置端專用憑證)**:
  - 僅包含該裝置被授權的本機執行 Scope（如 `local:read`、`local:write`、`local:test`）。
  - Token 簽發後由 API 單次輸出，伺服端僅持久化 SHA-256 雜湊值（`tokenHash`）與 Token ID（`activeTokenId`），無法從資料庫反向還原明文。
  - 具備過期時間（限制在 60 秒至 365 天之間，預設 90 天），杜絕無期限永久 Token。

### 2. Device Scope 嚴格白名單 (`ALLOWED_DEVICE_SCOPES`) 與預設最小權限
為防止裝置藉由註冊 API 提權存取管理端或提交任務，系統強制限制裝置 Scope 僅限於以下本機執行權限：
```ts
export const ALLOWED_DEVICE_SCOPES = new Set<string>([
  'device:connect',
  'local:read',
  'local:write',
  'local:test',
  'local:exec',
  'local:list_projects',
  'local:project_status',
  'local:read_file',
  'local:write_file',
  'local:patch_file',
  'local:list_directory',
  'local:find_files',
  'local:search_text',
  'local:find_repositories',
  'local:create_directory',
  'local:git_status',
  'local:run_tests',
  'local:build_project',
  'artifacts:read'
]);
```
- **最小權限預設 (Least Privilege Default)**:
  若管理端調用 `POST /admin/devices` 時省略 `capabilities`，系統將**嚴格預設為最小唯讀權限 `['local:read', 'artifacts:read']`**。
  絕不自動賦予 `local:write`、`local:exec`、Host Execution 或 Raw Shell 權限。
- **快取防禦標頭 (No-Store Cache Headers)**:
  裝置註冊回應標頭強制設定 `Cache-Control: no-store` 與 `Pragma: no-cache`，確保 Token 不被快取代理伺服器留存。
- 任何包含 `admin`、`tasks:submit`、`tasks:cancel`、`kaggle:*` 的請求將立即遭阻擋並回傳 `INVALID_DEVICE_SCOPE`。

### 3. 已撤銷裝置重註冊安全性 (Revocation & Superseding)
- 當裝置被管理員撤銷時：
  - 裝置狀態設定為 `revoked`，現有 WebSocket 立即中斷。
  - 其當前 `activeTokenId` 自動存入 `revoked_tokens` 表。
  - KillSwitch 同步將該 Device ID 加入黑名單。
- 若管理員重新註冊同一個 `deviceId`：
  - 舊有的 `activeTokenId` 維持在撤銷清單中，舊 Token 永遠無法重新認證（回傳 `TOKEN_SUPERSEDED` 或 `TOKEN_REVOKED`）。
  - 只有新簽發的 Token 配合新產生的 `activeTokenId` 方可連線。

---

## 二、任務定向路由 (`targetDeviceId`) 安全防護

### 1. 任務錯配防護 (Anti-Misrouting)
- **提交期限制**:
  - 當系統存在多台已註冊裝置或線上有多台 Agent 時，用戶端若未指明 `targetDeviceId`，`TaskRouter` 立即拋出 `AMBIGUOUS_DEVICE_TARGET` 拒絕任務排隊（Fail Closed）。
  - 若其中 1 台電腦在線、另 1 台電腦離線，亦禁止自動將任務偷派給在線電腦，杜絕「原本要跑在 New PC 的任務因 New PC 離線而被 Old PC 搶走執行」。
- **認領期限制 (Strict Fail-Closed Claim Protection)**:
  - `TaskStore.claimTask` 與 `TaskStore.claimTaskById` 強制校驗：
    ```ts
    if (t.backend === 'local') {
      if (!t.targetDeviceId || t.targetDeviceId !== deviceId) return false;
    }
    ```
    ```ts
    if (task.backend === 'local' && (!task.targetDeviceId || task.targetDeviceId !== deviceId)) {
      return undefined; // 嚴格拒絕認領
    }
    ```
  - 本地任務**必須具備明確且相符之 `targetDeviceId`**，若歷史舊任務未綁定或指定給其他電腦，任何 Agent 輪詢或按 ID 認領一律嚴格拒絕。
- **逾期回收與重試安全**:
  - 當任務租約過期被回收時，`targetDeviceId` 欄位維持不變。
  - 重試佇列中該任務依然只能由原目標裝置認領，其它裝置輪詢一律跳過。

### 2. Idempotency Replay 安全性
- **權限優先驗證**:
  - 用戶端重放相同 `idempotencyKey` 時，系統**先驗證調用者是否具備該能力所需之 Scope**。無權限調用者一律回傳 403 `AUTH_FORBIDDEN`，無法藉由竊取之 idempotencyKey 刺探任務狀態或重放。
- **全參數衝突檢驗 (`IDEMPOTENCY_CONFLICT`)**:
  - 若重送之請求與原任務在以下欄位有任何不一致，立即拋出 `IDEMPOTENCY_CONFLICT`：
    1. `targetDeviceId`（包含原指定新省略、原省略新指定、指定不同裝置）
    2. `backend`（local vs kaggle vs swarm）
    3. `capability`（如 local:read_file vs local:write_file）
    4. `payload`（JSON 內容不同）

---

## 三、相容性與平滑過渡分析

### 1. 舊版單電腦環境相容性 (Single-Device Backward Compatibility)
- 若整個系統目前僅註冊一台電腦（如升級初期僅有 `win11-arm64-workstation`）：
  - 用戶端未帶 `targetDeviceId` 時，系統自動綁定該唯一的已註冊裝置。
  - ChatGPT 既有單電腦操作習慣 100% 維持運作，不會因未傳 `targetDeviceId` 而中斷。
- 當管理員透過 API 註冊第二台裝置（如 `win11-arm64-workstation-2`）後，系統自動升級為多裝置防護模式，強制要求明確指定目標。

### 2. 升級前歷史任務安全遷移 (`migrateLegacyUnassignedTasks`) 與隔離佇列架構 (Quarantine Architecture)
- **歷史任務歸屬判定原則 (Strict Ownership Evidence)**:
  - Gateway 在啟動或冷啟動水合時，自動審視歷史留存任務。
  - **具備可驗證歷史認領者**: 優先以歷史租約（`task.lease?.claimedBy`）或執行記錄（`task.attempts` 中的 `claimedBy`）鎖定原擁有者，確保重試不會送錯電腦。
  - **無歷史認領者或無法證明擁有權**:
    - **嚴禁自動綁定第一台連線或在線裝置**：`GatewayDurableObject` 與 `ConnectionManager` 在 `AGENT_REGISTER` 時**不再**調用 `migrateLegacyUnassignedTasks([deviceId])`。新電腦先連線、或舊電腦離線時新電腦連線，絕不自動搶奪舊任務。
    - **隔離佇列保護 (Quarantined in Queued, Zero Task Loss)**: 任務維持在 `status: 'queued'` 且 `targetDeviceId: undefined`。因本地任務認領要求 `t.backend === 'local' && (!t.targetDeviceId || t.targetDeviceId !== deviceId)` 判定，無 `targetDeviceId` 之任務嚴禁任何 Agent 認領（Fail Closed）。
    - **非破壞性零遺失**: 系統絕不無條件將歷史排隊任務標記為失敗或刪除，確保任務不遺失。
  - **管理員安全指派 API (`POST /admin/tasks/assign-legacy`) 與活躍白名單防護**:
    - 需具備 `ADMIN_SECRET` 方可調用。
    - 強制校驗目標裝置必須為已註冊且未被撤銷（Non-Revoked）之裝置。
    - **非空 `taskIds: string[]` 強制要求**: 必須傳入非空任務 ID 陣列（若為空或未提供回傳 400 Bad Request），杜絕無邊界全量指派。
    - **活躍狀態白名單 (`ACTIVE_TASK_STATUSES`) 與終態不可變性**:
      - 僅允許對處於活躍狀態（`queued`, `claimed`, `acknowledged`, `running`, `retrying`）的任務進行改派。
      - 終態任務（`succeeded`, `failed`, `cancelled`, `stale`）嚴格不可變，任何改派請求一律略過不變動。
    - 寫入結構化稽核日誌（包含操作員、目標裝置、指派數量與任務 ID 清單）。

### 3. 資料庫 Schema 遷移相容性
- 在 `devices` 資料表新增 `activeTokenId TEXT` 欄位。
- 採用非破壞性平滑 DDL 腳本：
  ```sql
  ALTER TABLE devices ADD COLUMN activeTokenId TEXT;
  ```
- 腳本被包含在 `try/catch` 容錯塊中。既有資料表紀錄在水合時保持有效，無需清空資料庫或手動下 SQL。

### 4. 舊電腦 Bootstrap Token 相容性與嚴禁重新註冊
- 舊電腦（`win11-arm64-workstation`）使用以 `MASTER_SECRET` HMAC-SHA256 簽署之 Bootstrap Token 連線。
- Gateway 連線層會在 WebSocket 認證成功時自動調用 `rememberAuthenticatedDevice`，收錄進 SQLite `devices` 表，且**不覆寫 `activeTokenId`**，確保舊 Token 永遠有效。
- **嚴禁使用 `POST /admin/devices` 補登舊電腦 ID**：若管理端調用此 API 註冊同一 ID，將會產生新的 `activeTokenId`，使得舊電腦之 Bootstrap Token 在驗證時被判定為 `TOKEN_SUPERSEDED` 而永久斷線（已由 `Task B16` 完整測試證實）。

### 5. Raw Shell 安全邊界
- 本次升級完全不開放 Raw Shell。
- Local Agent 預設 `allowRawShell: false`。
- 本機專案目錄限制僅授權登記於 `projects.json` 的路徑，不得存取未授權磁碟分割區。

---

## 四、正式環境任務盤點 CLI 工具 (`scripts/inventory-tasks.ts`)

- **功能與介面**:
  - 提供 `npm run inventory:tasks` 唯讀盤點腳本，支援分頁（`--limit`、`--offset`）、過濾（`--backend`、`--status`）、格式切換（`--format table|json`）與就緒檢查（`--check-readiness`）。
  - **舊版端點 Fail Closed 安全防護**: 自動偵測舊版生產端點（`v2.1.0 @ 1a933d3`），由於舊版端點無法證明零未綁定任務，無論回傳幾筆資料一律回傳 Exit Code 2（BLOCKED），絕不因回傳 0 筆誤判 READY。
  - **正式環境真實 SQL 備援機制**: 提示運維人員透過 Cloudflare Dashboard -> Workers & Pages -> Durable Objects -> `GatewayDurableObject` -> `devspace-gateway-default` -> Data Studio / SQL Console 執行真實唯讀 SQL 查詢。
  - **嚴格 Schema 與統計一致性校驗**:
    - 回應必須具備完整 `summary`、`offset`、`limit`、`hasMore` 與任務陣列。
    - 嚴格校驗：`totalActiveLocal === totalTargeted + totalQuarantined`、`totalWithPriorClaimant <= totalQuarantined`，且 `byStatus` 各狀態加總精確等於 `totalActiveLocal`。
    - 驗證分頁任務數不大於 `limit`、`hasMore` 布林值邏輯正確，各任務必須具備 `id`、`status`、`backend`、`isQuarantined` 等欄位。
    - 任何統計矛盾、格式損壞或不完整均立即 Fail Closed（Exit Code 2）。
  - 嚴格資料脫敏：自動過濾任務代碼與敏感憑證，僅呈現狀態、裝置 ID、認領歷程與摘要統計。
  - 明確退出碼：`0`（READY，無未綁定任務）、`1`（ERROR，網路或授權錯誤）、`2`（BLOCKED，存在隔離/未綁定任務或資料異常，阻擋正式部署）。
- **受控單元測試覆蓋**:
  - `tests/unit/inventory-tasks.test.ts` 擴充至 53 項測試，覆蓋遺失密鑰拒絕、網路超時、401 拒絕、舊版 0 筆阻擋、舊版 >100 筆阻擋、統計矛盾阻擋、分頁不完整阻擋、任務格式損壞阻擋、Data Studio 指引驗證、脫敏保證與就緒驗收。

---

## 五、GitHub Actions 生產部署門禁解耦安全架構

- **解耦核心原則**:
  - **Push / Merge to `main` 絕不觸發生產部署**：僅執行 CI 跨平臺矩陣驗證與 Cloudflare deploy `--dry-run`。
  - **生產部署僅限手動觸發 (`workflow_dispatch`)**:
    - 限由授權操作員於 `refs/heads/main` 手動觸發。
    - 必須明確勾選 `deploy_production: true`。
    - 必須明確勾選 `preflight_inventory_confirmed: true`（確認已完成前置任務盤點且無風險）。
    - **`target_commit_sha` 強制必填（`required: true`）與安全鎖定**:
      - 參數透過 safe `env:` 變數傳入（`INPUT_TARGET_SHA`），防範 Shell 腳本注入攻擊。
      - 嚴格校驗格式為 40 位 16 進位字串（`^[0-9a-fA-F]{40}$`）。
      - 工作流比對該 SHA 必須與目標 Commit (`$GITHUB_SHA`) 完全吻合，防止併發推播或任意 Commit 導致錯誤部署。
- **受控單元測試覆蓋**:
  - `tests/unit/workflow-deployment-gate.test.ts` 擴充至 32 項測試，涵蓋 PR 阻擋、Push 阻擋、缺少確認阻擋、非 main 分支阻擋、空 SHA 拒絕、短 SHA 拒絕、非 16 進位拒絕、注入字元拒絕、SHA 不吻合拒絕與 SHA 吻合放行驗證。
