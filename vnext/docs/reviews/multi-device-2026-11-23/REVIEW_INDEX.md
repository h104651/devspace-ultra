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

1. **修復 GitHub CI 真實失敗 (Task B7)**:
   - 解決 Task B7 在 GitHub Actions Linux 虛擬機上因即時 Agent 輪詢搶先執行 Stale Recovery 導致的非同步競態斷言問題。
   - 補齊隔離測試 `Task B7b`，驗證 Stale Recovery 在無背景干擾下的精準回收與重試耗盡終態。
2. **補齊最後的路由安全問題**:
   - 完整五種裝置狀態路由矩陣（0註冊/0在線、1註冊/0在線、2註冊/0在線、1在線/2註冊、2在線/2註冊），杜絕模糊派工。
   - 強化 Idempotency Replay 防護：禁止未授權請求透過 Idempotency 繞過權限；完整比對 `targetDeviceId`、`backend`、`capability`、`payload` 參數衝突。
   - 舊任務遷移保證 Fail Closed，禁止歷史未綁定任務被錯誤裝置領取；在 0 註冊裝置冷啟動時標記失敗（`AMBIGUOUS_LEGACY_TASK`）。
   - `claimTask` 與 `claimTaskById` 嚴格限制本地任務只有明確指定且匹配該裝置之 `targetDeviceId` 方可領取（Fail Closed）。
3. **完成全套回歸測試與 Wrangler Dry Run**:
   - 458 / 458 測試 PASS（0 失敗，連續 3 次通過）。
   - Wrangler 部署預檢 PASS。
4. **交付 7 份審查技術文件**:
   - 保存在 `vnext/docs/reviews/multi-device-2026-11-23/`，供 ChatGPT 與審查工程師完整閱讀與評估。

---

## 三、修改檔案清單 (Modified Files)

- `vnext/src/gateway/task-router.ts`:
  - 調整執行順序：Kill Switch -> Scope Authorization -> 裝置定向路由 -> Idempotency 檢查。
  - 強化 Idempotency 參數比對（`targetDeviceId`、`backend`、`capability`、`payload`），拋出 `IDEMPOTENCY_CONFLICT`。
  - 當存在多台裝置時，無 `targetDeviceId` 任務嚴格拒絕（拋出 `AMBIGUOUS_DEVICE_TARGET`）。
- `vnext/src/security/auth-manager.ts`:
  - `ALLOWED_DEVICE_SCOPES` 白名單檢驗，嚴格禁止賦予 `admin` 等非本機權限。
  - 裝置名稱、平臺、ID 格式輸入校驗；`expiresInMs` 限制 60 秒至 365 天。
  - 重新註冊時舊 Token 永久作廢（`activeTokenId` 追蹤與置換）。
- `vnext/src/cloudflare/sqlite-storage-adapter.ts`:
  - 非破壞性 SQLite 遷移 `ALTER TABLE devices ADD COLUMN activeTokenId TEXT`。
- `vnext/src/cloudflare/gateway-durable-object.ts` & `vnext/src/gateway/server.ts`:
  - 冷啟動時自動執行 `migrateLegacyUnassignedTasks`。
  - 重新註冊時調用 `killSwitch.unrevokeDevice`，撤銷時註銷 `activeTokenId`。
- `vnext/src/storage/task-store.ts`:
  - `migrateLegacyUnassignedTasks`: 歷史認領優先綁定、單裝置自動綁定、多裝置安全失敗（`AMBIGUOUS_LEGACY_TASK`）。
  - `claimTask` / `claimTaskById`: 嚴格限制只有符合 `targetDeviceId` 的裝置才可領取。
- `vnext/tests/integration/multi-device-routing.test.ts`:
  - 修復 Task B7 斷言與租約回收流程。
  - 新增 `Task B7b`（隔離環境租約回收與耗盡測試）。
  - 新增 `Task B13`（Idempotency 參數衝突與權限繞過防護測試）。
  - 新增 `Task B14`（五種裝置狀態路由安全矩陣測試）。

---

## 四、審查文件索引 (Review Documents Index)

1. [ROOT_CAUSE_AND_FIX.md](ROOT_CAUSE_AND_FIX.md): B7 失敗根因分析、P0/P1 安全收尾、代碼修復與前後行為比對。
2. [TEST_MATRIX.md](TEST_MATRIX.md): 458+ 項全套測試矩陣、連續 3 次 PASS 執行記錄、Wrangler 預檢結果。
3. [SECURITY_AND_COMPATIBILITY.md](SECURITY_AND_COMPATIBILITY.md): 零信任資安架構、Token 限制、權限白名單、快取標頭、相容性與回歸分析。
4. [DEPLOYMENT_AND_ROLLBACK.md](DEPLOYMENT_AND_ROLLBACK.md): Cloudflare 正式部署 SOP、CLI 啟動規格、正式狀態差異分析、緊急回滾方案與不可逆資料保護。
5. [CI_EVIDENCE.md](CI_EVIDENCE.md): 原始失敗 CI Run、修復後本機與遠端 CI 驗收證據。
6. [OPEN_ISSUES.md](OPEN_ISSUES.md): 已解決與尚未解決項目、風險等級、Merge 與 Deploy 阻擋評估。

---

## 五、最終結論判定 (GO / NO-GO)

- **程式碼修復與安全強化**: **GO** (100% 完成且經單元/整合驗證)
- **本機 Windows ARM64 測試**: **GO** (458/458 PASS)
- **Cloudflare 部署預檢 (Dry Run)**: **GO** (Exit code 0, 資源 Binding 完整)
- **GitHub PR Merge 資格**: **GO** (代碼完整、Draft PR 就緒、審查文件齊全)
- **正式環境部署資格 (Production Deploy)**: **CONDITIONAL GO** (等待 ChatGPT 人工完成 GitHub 審查，並由管理者簽發正式 Device Token 後方可執行)
