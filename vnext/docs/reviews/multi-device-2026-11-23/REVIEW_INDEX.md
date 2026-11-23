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

1. **Task 1 (P0) — 歷史任務不可自動綁定第一台連線裝置**:
   - 移除 `AGENT_REGISTER` 與連線時單裝置自動獲取歷史任務之漏洞。連線本身**絕不構成任務擁有權之證明**。
   - 歷史任務優先依可驗證之歷史 Lease / Attempt 記錄恢復原擁有者 (`targetDeviceId = priorClaimant`)。
   - 無法證明擁有權之任務，安全隔離於 `queued` 狀態且 `targetDeviceId: undefined`，`claimTask` 嚴格拒絕領取（Fail Closed）。
   - 提供受保護的管理員指派端點 `POST /admin/tasks/assign-legacy`，經身分驗證與目標裝置合法性校驗後方可指派。
   - 擴充測試矩陣：舊裝置先上線、新裝置先上線、新裝置已註冊舊裝置離線、雙裝置同時連線、有 Claimant、無 Claimant、DO 冷啟動、多裝置斷線與租約回收等 8 大情境（`Task B18` ~ `Task B24`，Suite 18 擴充至 33 項測試）。
2. **Task 2 (P0) — 真正可使用的唯讀任務盤點方案**:
   - 在 Gateway DO 與 Server 實作分頁與全量盤點介面（`/admin/tasks?view=inventory`），提供 Target Device、Claimant、Lease 與 Attempt 摘要，嚴格唯讀且全域脫敏。
   - 建立實際可執行腳本 `vnext/scripts/inventory-tasks.ts`（支援 `npm run inventory:tasks`），自動識別舊版 Schema、提供 Wrangler Direct SQL 查詢備援、支援 Exit Code 0/1/2。
   - 建立獨立單元測試套件 `vnext/tests/unit/inventory-tasks.test.ts`（30 項測試）。
   - 明確標示當前正式環境盤點為 **PRODUCTION PREFLIGHT BLOCKED**，未完成盤點前正式部署一律標記為 **NO-GO**。
3. **Task 3 (P0) — 改正 GitHub 自動部署順序與門禁**:
   - 修改 `.github/workflows/vnext-ci.yml`，將 `deploy-production` 嚴格限制為手動 `workflow_dispatch`，普通 `main` Push 或 PR Merge 絕不自動部署。
   - 部署條件限制：必須在 `refs/heads/main`、`deploy_production == true`、`preflight_inventory_confirmed == true`，並在 Step 中校驗 `target_commit_sha`。
   - 建立門禁邏輯單元測試套件 `vnext/tests/unit/workflow-deployment-gate.test.ts`（22 項測試）。
4. **Task 4 — 修正正式部署 SOP**:
   - 確立十階段防護門禁序列 (A ~ J)，明確禁止為舊 Agent 重新註冊或簽發 Token。
5. **完成全套回歸測試與 Wrangler Dry Run**:
   - 519 / 519 測試 PASS（42 個測試套件，0 失敗）。
   - Wrangler 部署預檢 PASS。
6. **交付 7 份審查技術文件**:
   - 保存在 `vnext/docs/reviews/multi-device-2026-11-23/`，供 ChatGPT 與審查工程師完整閱讀與評估。

---

## 三、修改檔案清單 (Modified Files)

- `vnext/src/storage/task-store.ts`:
  - `migrateLegacyUnassignedTasks`: 僅自動遷移具備歷史 Claimant 之任務；無證明者保留隔離佇列，絕不任意綁定或直接失敗。
  - 新增 `assignQuarantinedTasks`: 供管理員手動指定目標裝置。
- `vnext/src/gateway/connection-manager.ts` & `vnext/src/cloudflare/gateway-durable-object.ts`:
  - 徹底移除 `AGENT_REGISTER` 時根據在線裝置自動綁定歷史任務之邏輯。
  - 增設 `POST /admin/tasks/assign-legacy` 受保護端點。
  - 增設 `GET /admin/tasks?view=inventory` 唯讀盤點介面（支援分頁與統計）。
- `vnext/src/gateway/server.ts`:
  - 同步增設 `/admin/tasks` 盤點介面與 `/admin/tasks/assign-legacy` 端點。
- `vnext/src/cloudflare/sqlite-storage-adapter.ts` & `src/storage/storage-adapter.interface.ts`:
  - `listTasks` 支援 `offset` 分頁查詢。
- `vnext/scripts/inventory-tasks.ts`:
  - 新增唯讀任務盤點與預檢 CLI 腳本。
- `.github/workflows/vnext-ci.yml`:
  - 修正部署門禁，完全解耦 PR Merge 與生產環境部署。
- `vnext/tests/integration/multi-device-routing.test.ts`:
  - 增補 Task B18 至 B24（涵蓋 8 大連線與所有權場景）。
- `vnext/tests/unit/inventory-tasks.test.ts`:
  - 盤點腳本功能、輸出脫敏、舊版相容與 Exit Code 測試（30 tests）。
- `vnext/tests/unit/workflow-deployment-gate.test.ts`:
  - GitHub Actions 部署門禁與條件驗證測試（22 tests）。
- `vnext/tests/security/security.test.ts`:
  - 改用動態可用連接埠（`port: 0`），徹底避免 Windows 系統連接埠衝突。

---

## 四、審查文件索引 (Review Documents Index)

1. [ROOT_CAUSE_AND_FIX.md](ROOT_CAUSE_AND_FIX.md): 歷史任務不可自動綁定第一台裝置分析、零遺失隔離架構、代碼修復與前後比對。
2. [TEST_MATRIX.md](TEST_MATRIX.md): 519 項全套測試矩陣（42 個套件）、連續 PASS 執行記錄、Wrangler 預檢結果。
3. [SECURITY_AND_COMPATIBILITY.md](SECURITY_AND_COMPATIBILITY.md): 零信任資安架構、Token 限制、權限白名單、部署門禁相容性分析。
4. [DEPLOYMENT_AND_ROLLBACK.md](DEPLOYMENT_AND_ROLLBACK.md): 十階段正式部署 SOP (A ~ J)、唯讀盤點操作指引、緊急回滾方案與不可逆資料保護。
5. [CI_EVIDENCE.md](CI_EVIDENCE.md): 本機與 GitHub Actions 双 CI Run 驗收證據。
6. [OPEN_ISSUES.md](OPEN_ISSUES.md): 已解決項目、正式環境盤點 BLOCKED 說明、4 級 GO/NO-GO 判定。

---

## 五、最終結論判定 (GO / NO-GO)

- **程式碼修復與架構審查 (Code Review)**: **GO** (所有漏洞修復完成且具備完整單元/整合驗證)
- **自動化測試 (Automated CI)**: **GO** (519/519 PASS，42 套件全綠)
- **GitHub PR Merge 資格 (PR Merge to main)**: **GO** (代碼與文檔完整，PR #23 就緒，Merge 不會觸發部署)
- **正式環境部署資格 (Production Deploy)**: **NO-GO** (嚴格維持 **NO-GO / PREFLIGHT BLOCKED**，必須於維護窗口由運維人員完成正式環境盤點後方可人工放行)
