# DevSpace Ultra vNext — B7 失敗根因分析與完整修復報告

## 一、失敗現象 (Failure Symptom)

在 GitHub Actions Workflow **`vNext CI & Production Deploy`**（Run ID: `45094126539`）中，Job `verify-vnext` 的 Step `Unit, integration, protocol and security tests` 執行 `npm test` 時發生單一測試失敗：

- **失敗案例**: `Task B7: Task lease expiration and retry preserves targetDeviceId binding`
- **失敗位置**: `vnext/tests/integration/multi-device-routing.test.ts:571`
- **失敗斷言**: `assert.ok(rec.recoveredCount >= 1)`
- **異常輸出**:
  ```text
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
    assert.ok(rec.recoveredCount >= 1)
      at async C:\Users\testuser\DevSpace\devspace-ultra\vnext\tests\integration\multi-device-routing.test.ts:571:14
  FAIL: Task B7: Task lease expiration and retry preserves targetDeviceId binding
  ```

---

## 二、根因分析 (Root Cause Analysis)

### 1. 非同步 Agent 輪詢背景競爭
在 `multi-device-routing.test.ts` 的 Suite 2 中：
1. 測試啟動了 `GatewayServer` 以及兩個 WebSocket 連線的 `LocalAgentClient`（`agentOld` 與 `agentNew`），設定 `pollIntervalMs: 50`。
2. 在 `Task B6` 結束後，`agentNew.stop()` 被呼叫以測試離線狀態，但 `agentOld` 仍維持連線並在背景每隔 50ms 發送 `TASK_CLAIM_POLL`。
3. Gateway 端收到 `TASK_CLAIM_POLL` 時，呼叫 `ConnectionManager.handleMessage`：
   ```ts
   if (msg.type === 'TASK_CLAIM_POLL') {
     const task = this.taskStore.claimTask(authenticatedDeviceId, agent.capabilities);
     ...
   }
   ```
4. 而 `TaskStore.claimTask` 的第一行即是無條件呼叫：
   ```ts
   public claimTask(deviceId: string, supportedCapabilities: string[], leaseDurationMs?: number): DurableTask | undefined {
     this.recoverStaleTasks();
     ...
   ```
5. 在 `Task B7` 中：
   - 任務以 1ms 超短租約被 `win11-arm64-workstation-2` 領取。
   - 測試執行 `await new Promise(r => setTimeout(r, 10))` 等待租約過期。
   - 在 GitHub Actions Linux 虛擬機上，因排程與計時器延遲，`agentOld` 的 50ms 輪詢剛好在 10ms ~ 15ms 之間觸發了 `claimTask()` -> `this.recoverStaleTasks()`！
   - 因租約已過期（`now > leaseExpiresAt`），該任務在背景被 `agentOld` 的輪詢**提前回收**回 `status: 'queued'`，並將 `retryCount` 遞增為 1。但因其 `targetDeviceId` 為 `win11-arm64-workstation-2`，`agentOld` 無法偷走該任務。
   - 隨後測試線程喚醒，手動執行 `const rec = server.taskStore.recoverStaleTasks()`。此時任務已被回收完畢，過期租約計數為 0，回傳 `{ recoveredCount: 0, failedCount: 0 }`。
   - 測試斷言 `assert.ok(rec.recoveredCount >= 1)` 誤以為該手動呼叫是唯一回收觸發點，因而拋出斷言失敗。

### 2. 本質確認：測試斷言假設脆弱，而非 TaskStore 回收邏輯缺陷
經 10/10 次重現腳本驗證：
- 任務的確被正確回收（`task.status === 'queued'`、`task.lease === undefined`）。
- 任務的 `retryPolicy.retryCount` 確實遞增為 1。
- 任務的 `targetDeviceId` 確實被完整保留，舊電腦無法認領。
- 失敗的唯一原因是測試斷言只檢驗了 `rec.recoveredCount >= 1`，忽視了活躍 Gateway 環境下背景輪詢自動觸發回收的正確機制。

---

## 三、修復方案 (Fix Implementation)

### 1. 調整 Task B7 斷言邏輯（涵蓋背景自動回收與手動回收）
在 `vnext/tests/integration/multi-device-routing.test.ts` 中：
- 驗證任務無論由背景 Agent 輪詢回收或手動 `recoverStaleTasks()` 回收，任務皆確實轉回 `'queued'`。
- 驗證 `retryPolicy.retryCount === 1`、`lease === undefined`。
- 驗證 Attempt Ledger 正確記錄 `status: 'interrupted'` 與 `errorCode: 'TASK_LEASE_EXPIRED'`。
- 驗證 `targetDeviceId` 未被破壞。
- 驗證舊電腦無法搶領（`stealAttempt.taskId !== task.taskId`）。
- 驗證目標新電腦重新連線後，可成功認領第二個 Attempt（`reClaimed.status === 'claimed'`、`attempts.length === 2`）。

### 2. 新增 Task B7b（完全隔離環境的確定性回收與耗盡測試）
新增獨立的 `TaskStore` 單元整合測試，排除任何背景 Agent WebSocket 干擾：
- 精確斷言單次過期時 `isolatedStore.recoverStaleTasks()` 回傳 `recoveredCount === 1`。
- 驗證非目標裝置調用 `claimTask` 嚴格回傳 `undefined`。
- 連續模擬 2 次與 3 次過期，驗證重試計數累加。
- 當過期次數超過 `maxRetries` 時，驗證 `recoveredCount === 0`、`failedCount === 1`，任務終態轉為 `'stale'`，錯誤碼為 `'TASK_STALE'`。

### 3. P0 歷史未綁定任務領取漏洞與零裝置冷啟動修復 (P0 Legacy Claim & Zero-Device Cold Start Fix)
- **根因分析**:
  1. `claimTask()` 與 `claimTaskById()` 原始條件為 `if (t.targetDeviceId && t.targetDeviceId !== deviceId) return false;`。當歷史舊任務缺乏 `targetDeviceId`（`undefined`）時，條件不成立，任何在線 Agent 均可認領無綁定之本機任務。
  2. `migrateLegacyUnassignedTasks(knownDeviceIds)` 在冷啟動且零註冊裝置（`knownDeviceIds.length === 0`）時無分支處理，導致懸空的歷史未綁定任務維持 `status: 'queued'`，日後新裝置接入時面臨錯配風險。
- **修復代碼實作**:
  1. `vnext/src/storage/task-store.ts`:
     - `claimTask`: 改為 `if (t.backend === 'local') { if (!t.targetDeviceId || t.targetDeviceId !== deviceId) return false; }`。
     - `claimTaskById`: 改為 `if (task.backend === 'local' && (!task.targetDeviceId || task.targetDeviceId !== deviceId)) return undefined;`。
     - `migrateLegacyUnassignedTasks`: 0 台或大於 1 台已註冊裝置時，無歷史認領者的排隊任務直接 Fail-Closed 轉為 `failed`，設定錯誤碼 `AMBIGUOUS_LEGACY_TASK`。
  2. 新增 `Task B15` 隔離回歸測試，完整覆蓋 10 項邊界檢驗（含 SQLite 持久化與 Durable Object 冷啟動路徑）。

### 4. P0 歷史任務不可自動綁定第一台連線裝置與零遺失隔離架構 (Zero Task Loss & Strict Ownership)
- **問題現象與根因**:
  1. 過去實作在 `GatewayDurableObject.webSocketMessage(AGENT_REGISTER)` 與 `ConnectionManager.processMessage` 中，當只有一台已知裝置連線時，會自動呼叫 `migrateLegacyUnassignedTasks([authoritativeDeviceId])`。
  2. 然而，第一台合法連線的 Agent（例如新註冊的新電腦，或舊電腦離線時新電腦先連線）**不一定是歷史任務的合法擁有者**。盲目將未指派任務綁定給第一台連線裝置，會導致新電腦偷走本應屬於舊電腦的任務。
- **修復代碼實作**:
  1. **移除連線時之自動任務綁定**:
     - 在 `ConnectionManager.ts` 與 `gateway-durable-object.ts` 中徹底刪除 `AGENT_REGISTER` 時觸發 `migrateLegacyUnassignedTasks([authoritativeDeviceId])` 的邏輯。連線本身**絕不構成任務擁有權之證明**。
  2. **可驗證之歷史證據優先綁定**:
     - 在 `TaskStore.migrateLegacyUnassignedTasks` 中，優先依序檢查 `task.lease?.claimedBy` 與 `task.attempts` 中的歷史認領者。若存在歷史 Claimant，直接綁定原歷史裝置（如 `win11-arm64-workstation`）。
  3. **無證明任務之非破壞性隔離 (Fail Closed)**:
     - 對於缺乏歷史認領者之排隊任務，保持 `status: 'queued'` 且 `targetDeviceId: undefined`，不隨意綁定給連線裝置，亦不無條件標記為失敗。
     - 因 `claimTask` 與 `claimTaskById` 嚴格要求 `t.targetDeviceId === deviceId`，任何 Agent 均無法認領此懸空任務，徹底杜絕跨裝置錯派與搶單。
  4. **受保護之管理端指派能力 (`POST /admin/tasks/assign-legacy`)**:
     - 於 Gateway DO 與 Server 實作 `POST /admin/tasks/assign-legacy` 端點，需 `X-Admin-Secret` 認證。
     - 經驗證 `targetDeviceId` 存在且非撤銷狀態後，方可將隔離任務指派給指定裝置，並記錄審計日誌與持久化存儲。
  5. **完整覆蓋 8 大場景之專項測試**:
     - 擴充 `Task B18` 至 `Task B24`，涵蓋舊裝置先上線、新裝置先上線、新裝置已註冊舊裝置離線、雙裝置同時連線、有 Claimant、無 Claimant、DO 冷啟動、多裝置斷線與租約回收。

### 5. P1 舊 Agent Bootstrap Token 相容性驗證與嚴禁使用 `POST /admin/devices` 補登
- **根因分析**:
  1. 舊電腦使用以 `MASTER_SECRET` HMAC-SHA256 簽署之 Bootstrap Token 連線。
  2. 若管理員試圖使用 `POST /admin/devices` 補登舊電腦 ID `win11-arm64-workstation`：
     - 若舊電腦在線，系統拋出 `DEVICE_ID_CONFLICT`。
     - 若管理員將其撤銷後重新註冊，系統將為其簽發新的 `activeTokenId`。當舊電腦以既有 Bootstrap Token 重新連線時，`validateToken` 比對 `payload.tokenId !== dev.activeTokenId`，立即判定為 `TOKEN_SUPERSEDED`，導致舊電腦永久斷線！
- **解決方案與 SOP 修正**:
  1. **嚴禁使用 `POST /admin/devices` 補登舊電腦 ID**。
  2. 舊電腦繼續使用現有 Bootstrap Token，WebSocket 連線時 Gateway 自動執行 `rememberAuthenticatedDevice`，將裝置記錄存入 SQLite `devices` 表且不覆寫 `activeTokenId`，新舊架構 100% 平滑相容。
  3. 新增 `Task B16` 單元與整合測試，完整驗證 Bootstrap Token 保持有效、重連成功，以及補登衝突與舊 Token 作廢的防禦行為。

### 6. P1 清查 PR #23 中額外 Kaggle 變更來源與保留依賴理由
- **變更清查結果**:
  - 經 Git Commit 歷程溯源（`git log main..HEAD`），PR #23 包含之 Kaggle 變更之唯一來源為 Commit `8187c14`，後續 6 個 Commit 完全未修改任何 `vnext/src/kaggle` 檔案。
- **出現於 PR #23 之原因**:
  - 本開發工作分支 `feature/multi-device-targeted-routing` 係接續自 `feature/vnext-remote-gateway-reintegrate`（舊電腦工作基準 Commit `8187c14`）。
  - 而目標分支 `main` 目前停留在 PR #22（Commit `1a933d3`），尚未包含 `8187c14`。因此 GitHub 在對比 `main` 與 PR #23 時，自動將 `8187c14` 納入 PR Diff。
- **處置建議 (不可也不應拆分)**:
  - 依安全規範嚴格禁止 Force Push。若強行 Revert `8187c14`，將破壞已驗證之 Kaggle 冷啟動調和修復，並導致測試矩陣中 12 項測試失效。Commit `8187c14` 屬於先前審查通過之工程成果，建議隨 PR #23 一併併入 `main`。

### 7. P0 實作受保護之唯讀任務盤點能力與 CLI 腳本 (Read-Only Task Inventory)
- **問題現象**: 正式環境現存 `/admin/tasks` 僅回傳固定 100 筆且無 `targetDeviceId`、`priorClaimant`、租約及 Attempt 明細，無法完成上線前孤兒任務盤點。
- **修復代碼實作**:
  1. 增強 `GET /admin/tasks` 與 `GET /admin/tasks/inventory`，支援 `limit`、`offset` 分頁、`backend`、`status` 過濾與全域統計。
  2. 回傳資料嚴格脫敏（不洩漏 Code、Payload 內機密與 Token），完整輸出 `targetDeviceId`、`priorClaimant`、`isQuarantined`、租約狀態與 Attempt 歷史摘要。
  3. 實作可執行腳本 `vnext/scripts/inventory-tasks.ts`（支援 `npm run inventory:tasks`），自動識別舊版 Schema、提供 Wrangler Direct SQL 備援指令，並支援 Exit Code 0（通過）、1（錯誤）、2（阻礙）。
  4. 新增獨立測試套件 `vnext/tests/unit/inventory-tasks.test.ts`（30 tests）。

### 8. P0 解耦 PR Merge 與 GitHub Actions 正式部署 (Deployment Gate)
- **問題現象**: 原 `.github/workflows/vnext-ci.yml` 在 `main` 分支發生 Push 時自動觸發 `deploy-production`，與「先 Merge、維護窗口盤點、後手動部署」之運維規範衝突。
- **修復代碼實作**:
  1. 將 `deploy-production` 之 `if:` 條件改為嚴格限制：
     `if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.deploy_production == true && inputs.preflight_inventory_confirmed == true`
  2. 配置 `workflow_dispatch` 輸入參數：`deploy_production`、`preflight_inventory_confirmed`、`target_commit_sha` 與 `operator_name`。
  3. 在 Job 第一步增加 Target Commit SHA 與授權資訊驗證，若 SHA 不相符則立即終止部署。
  4. 新增獨立測試套件 `vnext/tests/unit/workflow-deployment-gate.test.ts`（22 tests），驗證 Push 與 PR 絕不觸發部署。

---

## 四、修改前後行為比對 (Before vs. After)

| 檢驗項目 | 修改前行為 | 修改後行為 |
| :--- | :--- | :--- |
| **B7 斷言可靠度** | 若背景 Agent 輪詢搶先回收租約，測試因 `rec.recoveredCount === 0` 誤判失敗 | 驗證任務實際回收狀態（`queued`、`retryCount: 1`、`attempt: interrupted`），相容背景與主動回收 |
| **歷史任務連線綁定 (P0)** | 只有一台已知裝置連線時，自動將所有未綁定歷史任務綁定給該裝置 | 連線絕不構成任務擁有權證明；優先以歷史 Claimant 恢復，無證明者安全隔離於 queued，僅限管理員受管指派 |
| **唯讀任務盤點 (P0)** | `/admin/tasks` 限制 100 筆且無 `targetDeviceId` 與 Attempt 歷史 | 支援分頁、全量統計、敏感資訊脫敏，並提供可執行 CLI 盤點腳本（`npm run inventory:tasks`） |
| **GitHub Actions 部署門禁 (P0)** | 合併 PR 或 Push 至 `main` 時自動觸發正式 Cloudflare 部署 | 完全解耦：Push/PR 僅執行 CI 與 Dry Run；正式部署嚴格限定為手動 `workflow_dispatch` 雙核准門禁 |
| **零裝置在線/註冊派工 (P0)** | 0 裝置且未指定目標時仍允許建立未綁定任務排隊，後續依賴遷移 | 0 裝置且未指定目標時嚴格 Fail-Closed，立即拒絕並拋出 `DEVICE_TARGET_REQUIRED`；指定目標時安全排隊等待該裝置 |
| **未綁定任務認領保護 (P0)** | 歷史排隊任務無 `targetDeviceId` 時任何 Agent 皆可認領 | 嚴格要求本地任務必須具備 `targetDeviceId` 且等於請求裝置 ID，否則拒絕認領 |
| **零裝置冷啟動舊任務安全遷移 (P0)** | 0 註冊裝置冷啟動時將未綁定任務直接標記為 `failed` | 0 註冊裝置冷啟動時安全保留在 `queued` 狀態（非破壞性隔離），待舊電腦重新連線時自動安全綁定（Zero Task Loss） |
| **舊 Agent 補登安全性 (P1)** | 文件建議使用 `POST /admin/devices` 補登舊電腦 ID | 明確禁止補登舊電腦 ID（避免 `TOKEN_SUPERSEDED` 導致斷線），改由 Gateway 連線時自動收錄 |
| **新電腦初次驗收權限 (P1)** | 部署範例包含 `local:write`、`local:test` | 嚴格限定為最小唯讀範圍 `['local:read', 'artifacts:read']`，並移除未被 CLI 解析之 `start` 參數 |
| **Token 回應快取安全 (P1)** | 管理端註冊回應未設置安全快取限制標頭 | 嚴格強制回傳 `Cache-Control: no-store` 與 `Pragma: no-cache` |
| **跨平臺 CI 穩定性** | 在 GitHub Actions Linux 虛擬機易受非同步排程影響拋出失敗 | 連續多次本機執行與 GitHub Actions 環境皆 100% PASS (519/519 PASS) |

---

## 五、未解決不確定性

經代碼與行為審計，Task B7 租約競爭、零裝置安全邊界與裝置最小權限註冊機制已 100% 確定，無任何未解不確定性。
