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

### 2. Device Scope 嚴格白名單 (`ALLOWED_DEVICE_SCOPES`)
為防止裝置藉由註冊 API 提權存取管理端或提交任務，系統強制限制裝置 Scope 僅限於以下本機執行權限：
```ts
export const ALLOWED_DEVICE_SCOPES = [
  'local:read',
  'local:write',
  'local:build',
  'local:test',
  'local:exec',
  'raw_shell:run',
  'artifacts:read',
  'artifacts:write'
] as const;
```
任何包含 `admin`、`tasks:submit`、`tasks:cancel`、`kaggle:*` 的請求將立即遭阻擋並回傳 `INVALID_DEVICE_SCOPE`。

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
- **認領期限制**:
  - `TaskStore.claimTask` 與 `TaskStore.claimTaskById` 強制校驗：
    ```ts
    if (task.backend === 'local' && task.targetDeviceId && task.targetDeviceId !== deviceId) {
      return undefined; // 嚴格拒絕認領
    }
    ```
  - 即使特定 Agent 試圖以輪詢或指定任務 ID 認領非指定任務，Gateway 端一律拒絕。
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

### 2. 升級前歷史任務安全遷移 (`migrateLegacyUnassignedTasks`)
- Gateway 在啟動或冷啟動水合時，自動審視歷史留存任務：
  - **有歷史認領者**: 綁定至該次租約認領者，確保重試不會送錯電腦。
  - **單裝置環境**: 自動補齊唯一裝置 ID。
  - **多裝置環境**: 歷史未綁定任務直接標記為失敗（`AMBIGUOUS_LEGACY_TASK`），嚴守 Fail Closed 原則。

### 3. 資料庫 Schema 遷移相容性
- 在 `devices` 資料表新增 `activeTokenId TEXT` 欄位。
- 採用非破壞性平滑 DDL 腳本：
  ```sql
  ALTER TABLE devices ADD COLUMN activeTokenId TEXT;
  ```
- 腳本被包含在 `try/catch` 容錯塊中。既有資料表紀錄在水合時保持有效，無需清空資料庫或手動下 SQL。

### 4. Raw Shell 安全邊界
- 本次升級完全不開放 Raw Shell。
- Local Agent 預設 `allowRawShell: false`。
- 本機專案目錄限制僅授權登記於 `projects.json` 的路徑，不得存取未授權磁碟分割區。
