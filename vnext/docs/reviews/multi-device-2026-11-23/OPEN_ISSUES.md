# DevSpace Ultra vNext — 問題追蹤、風險等級與上線評估

## 一、已解決問題清單 (Resolved Issues)

1. **[RESOLVED] Task B7 非同步輪詢競態導致 CI 失敗**:
   - 經診斷確認為背景 Agent 輪詢搶先執行了租約過期回收，導致隨後手動執行的回收計數為 0。
   - 重新設計斷言全面檢驗任務狀態、重試計數與歷史認領記錄，並新增隔離環境測試 `Task B7b`。
2. **[RESOLVED] 零裝置在線時任務排隊模糊分派風險**:
   - 在線裝置為 0 但多台已註冊時，未指定 `targetDeviceId` 的任務一律拒絕排隊（`AMBIGUOUS_DEVICE_TARGET`）。
3. **[RESOLVED] 歷史未綁定任務升級遷移安全性**:
   - 實作 `migrateLegacyUnassignedTasks`，歷史認領優先鎖定，多台已註冊時 Fail Closed 標記失敗，決不送錯電腦。
4. **[RESOLVED] 裝置註冊權限提權漏洞**:
   - 加入 `ALLOWED_DEVICE_SCOPES` 白名單，全面阻擋 `admin`、`tasks:submit` 等非裝置端執行 Scope。
5. **[RESOLVED] 已撤銷裝置重註冊舊 Token 復活漏洞**:
   - 透過 `activeTokenId` 追蹤當前合法憑證，重註冊時舊憑證永久失效。
6. **[RESOLVED] Idempotency Replay 跨裝置/跨參數污染與權限繞過**:
   - 調整執行順序，嚴格要求權限驗證通過後方可命中快取。比對 `targetDeviceId`、`backend`、`capability`、`payload` 衝突，拋出 `IDEMPOTENCY_CONFLICT`。
7. **[RESOLVED] 零裝置在線且零註冊時未指定目標之本機任務排隊漏洞 (P0)**:
   - 0 registered / 0 online / 未指定目標時，立即 Fail-Closed 拒絕並拋出 `DEVICE_TARGET_REQUIRED`。
   - 0 registered / 0 online / 已指定目標時，允許排隊但嚴格綁定 `targetDeviceId`，其它裝置無法認領。
8. **[RESOLVED] 裝置註冊預設最小權限與 Token 快取安全 (P1)**:
   - `POST /admin/devices` 省略 `capabilities` 時預設為最小唯讀範圍 `['local:read', 'artifacts:read']`，禁止自動授與寫入或執行權限。
   - 回應標頭設置 `Cache-Control: no-store` 與 `Pragma: no-cache`。
9. **[RESOLVED] CLI 啟動規格校正與生產環境狀態差異釐清 (P1)**:
   - 修正文件中的平臺參數為 `windows`，校正啟動指令為 `agent-cli.ts` 實際支援之環境變數與 `--projects-config` 格式。
   - 深入調查並說明生產環境舊電腦 `totalRegistered: 0 / totalOnline: 1` 歷史成因與向前相容保證。
10. **[RESOLVED] 歷史未綁定任務領取漏洞與 0 裝置冷啟動非破壞性隔離 (P0)**:
   - `TaskStore.claimTask` 與 `TaskStore.claimTaskById` 強制要求本地任務必須具備 `targetDeviceId` 且嚴格匹配請求裝置 ID，否則拒絕認領（Fail Closed 認領保護）。
   - `migrateLegacyUnassignedTasks` 針對 0 註冊裝置冷啟動環境，將未指定目標且無歷史認領者的任務非破壞性保留在 `queued` 狀態，阻止冒牌 Agent 認領，待唯一的舊 Agent 重新連線時自動安全綁定（Zero Task Loss），多裝置環境時則 Fail Closed 標記失敗。
   - 新增 `Task B15` 與 `Task B17` 隔離回歸測試，100% 通過。
11. **[RESOLVED] 舊 Agent Bootstrap Token 相容性與嚴禁管理端補登 (P1)**:
   - 經實測證實若以 `POST /admin/devices` 補登舊電腦 ID，將導致舊 Bootstrap Token 因 `TOKEN_SUPERSEDED` 永久失效。
   - 正式禁止此補登方式，改由 Gateway 連線時自動收錄，舊憑證保持 100% 向下相容。
   - 新增 `Task B16` 完整測試覆蓋。
12. **[RESOLVED] PR #23 中 Kaggle 變更來源釐清與保留依賴 (P1)**:
   - 查明 Kaggle 相關代碼與測試唯一來源為工作分支基準 Commit `8187c14`，非多裝置開發中無故引入。
   - 為避免破壞已通過之 12 項 Kaggle 冷啟動調和測試，且嚴守不使用 Force Push 原則，予以保留並詳實記錄於審查報告。

---

## 二、尚未解決與待上線後驗收項目 (Pending / Operational Items)

| 項目說明 | 影響範圍 | 風險等級 | 是否阻擋 Merge | 是否阻擋 Production Deploy | 是否阻擋新 Agent 上線 | 說明 / 處置方式 |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **正式環境歷史任務唯讀盤點** | 正式 Cloudflare Gateway | Medium | **否** | **是 (PREFLIGHT BLOCKED)** | **是** | 本地機器無正式 `ADMIN_SECRET`，依零洩漏原則禁止探測正式 SQLite，標記為 PREFLIGHT BLOCKED。需由架構師在部署時調用 `GET /admin/tasks` 盤點。 |
| **正式生產環境 Device Token 簽發** | 新 Windows 電腦 | Low | **否** | **否** | **是** | 依資安授權邊界，本輪禁止簽發正式憑證。需待 PR 合併並部署後，由管理員在安全管理介面手動簽發一次性 Token。 |
| **生產環境雙實機同時連線驗收** | 舊電腦與新電腦 | Low | **否** | **否** | **是** | 本機模擬測試（460 項）已全數 PASS，真實雙實機連線驗收需待正式部署完成後依 SOP 啟動。 |
| **ChatGPT MCP 端點實際對接測試** | ChatGPT 客戶端 | Low | **否** | **否** | **是** | 需於正式 Gateway 升級並加入第二台 Agent 後，由 ChatGPT 操作並指定 `targetDeviceId` 進行端對端驗收。 |

---

## 三、風險等級總評估 (Overall Risk Assessment)

- **代碼回歸風險**: **極低 (Very Low)**
  - 460 項全套自動化測試 100% 通過（連續三次確認無間歇性失敗）。
  - 單電腦環境保留自動綁定機制，100% 向後相容。
- **資料庫遷移風險**: **極低 (Very Low)**
  - SQLite 採非破壞性 `ALTER TABLE ADD COLUMN` 腳本，具備安全錯誤捕獲，不會損壞舊資料。
- **安全性與權限邊界**: **極高安全性 (Hardened Zero Trust)**
  - Scope 白名單、Idempotency 參數全校驗、Master Secret 嚴格隔離、已撤銷憑證永久失效。

---

## 四、最終決策建議 (Recommendation)

- **CODE 判定**: **GO** (代碼完全合規、安全修復到位、460 測試通過)
- **CI 判定**: **GO** (跨平臺多矩陣與 vNext Verify 綠燈)
- **MERGE 判定**: **GO** (Draft PR 已就緒，可由 ChatGPT 獨立審查後合併)
- **PRODUCTION DEPLOY 判定**: **HOLD / PREFLIGHT BLOCKED** (等待正式任務盤點確認與 ChatGPT 人工審核，嚴禁未經確認前自動部署)
