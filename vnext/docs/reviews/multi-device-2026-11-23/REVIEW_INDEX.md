# DevSpace Ultra vNext — 多裝置定向路由與部署審查入口

## 一、專案與審查基準

- **Repository URL**: [https://github.com/h104651/devspace-ultra](https://github.com/h104651/devspace-ultra)
- **工作分支 (Branch)**: `feature/multi-device-targeted-routing`
- **基準 Commit (Base Commit)**: `1a933d3 Merge PR #22: absorb transient Local Agent disconnects`
- **最終 HEAD Commit**: [檢視功能分支最新提交紀錄](https://github.com/h104651/devspace-ultra/commits/feature/multi-device-targeted-routing)
- **Draft PR**: [PR #23: feat(vnext): multi-device targeted routing, secure registration, and safety hardening](https://github.com/h104651/devspace-ultra/pull/23)
- **CI / GitHub Actions 失敗 Run**: [Workflow Run 45094126539](https://github.com/h104651/devspace-ultra/actions/runs/45094126539)

---

## 二、本次修復與交付目標

1. **Task 1 (P0) — 歷史任務不可自動綁定第一台連線裝置、活躍狀態白名單與租約衝突防護**:
   - 移除 `AGENT_REGISTER` 與連線時單裝置自動獲取歷史任務之漏洞。連線本身**絕不構成任務擁有權之證明**。
   - 歷史任務優先依可驗證之歷史 Lease / Attempt 記錄恢復原擁有者 (`targetDeviceId = priorClaimant`)。
   - 無法證明擁有權之任務，安全隔離於 `queued` 狀態且 `targetDeviceId: undefined`，`claimTask` 嚴格拒絕領取（Fail Closed）。
   - 嚴格實作活躍任務狀態白名單（`ACTIVE_TASK_STATUSES`: `queued`, `claimed`, `acknowledged`, `running`, `retrying`），終態任務（`succeeded`, `failed`, `cancelled`, `stale`）嚴格排除於活躍與隔離計數之外，且維持不可變性。
   - 提供受保護的管理員指派端點 `POST /admin/tasks/assign-legacy`，強制要求非空 `taskIds: string[]`、有效目標裝置校驗與有效租約衝突防護（未過期 Lease 且持有者不同時禁止改派），杜絕無界大量改派與搶奪進行中任務。
   - 擴充測試矩陣：舊裝置先上線、新裝置先上線、新裝置已註冊舊裝置離線、雙裝置同時連線、有 Claimant、無 Claimant、DO 冷啟動、多裝置斷線、租約回收、活躍狀態白名單及有效租約衝突防護等（`Task B18` ~ `Task B26`，Suite 18 擴充至 35 項測試）。
2. **Task 2 (P0) — 嚴格安全、全量分頁與統計一致之唯讀任務盤點方案**:
   - 在 Gateway DO 與 Server 實作分頁與全量盤點介面（`/admin/tasks?view=inventory`），提供 Target Device、Claimant、Lease 與 Attempt 摘要，嚴格唯讀且全域脫敏。
   - 建立實際可執行腳本 `vnext/scripts/inventory-tasks.ts`（支援 `npm run inventory:tasks`），自動識別舊版 Schema 並一律回傳 Exit Code 2（BLOCKED），杜絕舊版 0 筆誤判 READY；提供 Cloudflare Data Studio / SQLite console 查詢備援（使用單例實例 `global-gateway-singleton-recovery-20260910` 與 `taskId` 主鍵查詢）。
   - **就緒檢查模式篩選限制**：預設 Production Readiness 檢查僅允許評估全量活躍本機任務（`backend=local, status=active, offset=0`），指定部分篩選（如 `--backend kaggle`、`--status queued`、`--offset > 0`）一律 Fail Closed（Exit Code 2）。
   - **自動全量多頁分頁查詢**：`hasMore=true` 時自動循環獲取全部頁面，驗證每頁與累計筆數一致，分頁資料異動或出現重複任務立即 Fail Closed（Exit Code 2）。
   - 建立獨立單元測試套件 `vnext/tests/unit/inventory-tasks.test.ts`（擴充至 91 項測試）。
   - 明確標示當前正式環境盤點為 **PRODUCTION PREFLIGHT BLOCKED**，未完成盤點前正式部署一律標記為 **NO-GO**。
3. **Task 3 (P0) — 改正 GitHub 自動部署順序與 Commit SHA 門禁鎖定**:
   - 修改 `.github/workflows/vnext-ci.yml`，將 `deploy-production` 嚴格限制為手動 `workflow_dispatch`，普通 `main` Push 或 PR Merge 絕不自動部署。
   - 部署條件限制：必須在 `refs/heads/main`、`deploy_production == true`、`preflight_inventory_confirmed == true`。
   - `target_commit_sha` 設為強制必填（`required: true`），透過安全 `env:` 變數傳入以防 Shell 注入，嚴格檢驗 40 位 16 進位格式並確認與 `$GITHUB_SHA` 完全吻合。
   - 建立門禁邏輯單元測試套件 `vnext/tests/unit/workflow-deployment-gate.test.ts`（擴充至 32 項測試）。
4. **Task 4 — 修正正式部署 SOP**:
   - 確立十階段防護門禁序列 (A ~ J)，明確禁止為舊 Agent 重新註冊或簽發 Token。
5. **完成全套回歸測試與 Wrangler Dry Run**:
   - 592 / 592 測試 PASS（42 個測試套件，0 失敗）。
   - Wrangler 部署預檢 PASS（Total Upload: 465.29 KiB / gzip: 93.27 KiB）。
6. **交付 7 份審查技術文件**:
   - 保存在 `vnext/docs/reviews/multi-device-2026-11-23/`，供 ChatGPT 與審查工程師完整閱讀與評估。

---

## 三、修改檔案清單 (Modified Files)

- `vnext/src/types/task.ts`:
  - 定義並導出 `ACTIVE_TASK_STATUSES` 與 `TERMINAL_TASK_STATUSES` 白名單。
- `vnext/src/storage/task-store.ts`:
  - `migrateLegacyUnassignedTasks`: 僅自動遷移具備歷史 Claimant 之任務；無證明者保留隔離佇列，絕不任意綁定或直接失敗；僅統計活躍任務。
  - `assignQuarantinedTasks`: 強制要求非空 `taskIds: string[]`，嚴格排除終態任務，保證歷史任務不可變性；增設有效租約衝突防護（未過期且持有者不同時禁止改派）。
- `vnext/src/gateway/connection-manager.ts` & `vnext/src/cloudflare/gateway-durable-object.ts`:
  - 徹底移除 `AGENT_REGISTER` 時根據在線裝置自動綁定歷史任務之邏輯。
  - 增設 `POST /admin/tasks/assign-legacy` 受保護端點，校驗非空 `taskIds` 與已註冊且未撤銷目標裝置。
  - 增設 `GET /admin/tasks?view=inventory` 唯讀盤點介面（依 `ACTIVE_TASK_STATUSES` 白名單過濾，支援分頁與統計）。
- `vnext/src/gateway/server.ts`:
  - 同步增設 `/admin/tasks` 盤點介面與 `/admin/tasks/assign-legacy` 端點，嚴格套用活躍白名單與輸入校驗。
- `vnext/src/cloudflare/sqlite-storage-adapter.ts` & `src/storage/storage-adapter.interface.ts`:
  - `listTasks` 支援 `offset` 分頁查詢。
- `vnext/scripts/inventory-tasks.ts`:
  - 新增唯讀任務盤點與預檢 CLI 腳本，舊版端點一律 Exit Code 2，實施就緒篩選限制、全量自動多頁分頁、分頁異動檢驗，提供 Cloudflare Data Studio SQL 指引（定位單例實例 `global-gateway-singleton-recovery-20260910`）。
- `.github/workflows/vnext-ci.yml`:
  - 修正部署門禁，完全解耦 PR Merge 與生產環境部署，強制必填 `target_commit_sha`（40 位 16 進位安全校驗）。
- `vnext/tests/integration/multi-device-routing.test.ts`:
  - 增補 Task B18 至 B26（擴充至 35 項測試，涵蓋連線所有權、管理員指派校驗、活躍狀態白名單隔離與租約衝突防護）。
- `vnext/tests/unit/inventory-tasks.test.ts`:
  - 盤點腳本功能、輸出脫敏、舊版相容、Exit Code、舊版 SQLite Schema 模擬解析、就緒篩選限制、全量分頁與異動檢驗測試（擴充至 91 項測試）。
- `vnext/tests/unit/workflow-deployment-gate.test.ts`:
  - GitHub Actions 部署門禁與條件驗證測試（擴充至 32 項測試）。
- `vnext/tests/security/security.test.ts`:
  - 改用動態可用連接埠（`port: 0`），徹底避免 Windows 系統連接埠衝突。

---

## 四、審查文件索引 (Review Documents Index)

1. [ROOT_CAUSE_AND_FIX.md](ROOT_CAUSE_AND_FIX.md): 歷史任務不可自動綁定第一台裝置分析、活躍狀態白名單、租約衝突防護、零遺失隔離架構、代碼修復與前後比對。
2. [TEST_MATRIX.md](TEST_MATRIX.md): 592 項全套測試矩陣（42 個套件）、連續 PASS 執行記錄、Wrangler 預檢結果。
3. [SECURITY_AND_COMPATIBILITY.md](SECURITY_AND_COMPATIBILITY.md): 零信任資安架構、Token 限制、權限白名單、部署門禁 SHA 鎖定與相容性分析。
4. [DEPLOYMENT_AND_ROLLBACK.md](DEPLOYMENT_AND_ROLLBACK.md): 十階段正式部署 SOP (A ~ J)、Data Studio 盤點操作指引（正確單例實例定位）、緊急回滾方案與不可逆資料保護。
5. [CI_EVIDENCE.md](CI_EVIDENCE.md): 本機 592 測試與 GitHub Actions CI 驗收證據。
6. [OPEN_ISSUES.md](OPEN_ISSUES.md): 已解決項目、正式環境盤點 BLOCKED 說明、4 級 GO/NO-GO 判定。

---

## 五、最終結論判定 (GO / NO-GO)

- **程式碼修復與架構審查 (Code Review)**: **GO** (所有漏洞修復完成且具備完整單元/整合驗證)
- **自動化測試 (Automated CI)**: **GO** (592/592 PASS，42 套件全綠)
- **GitHub PR Merge 資格 (PR Merge to main)**: **GO** (代碼與文檔完整，PR #23 就緒，Merge 不會觸發部署)
- **正式環境部署資格 (Production Deploy)**: **NO-GO** (嚴格維持 **NO-GO / PREFLIGHT BLOCKED**，必須於維護窗口由運維人員完成正式環境盤點後方可人工放行)
