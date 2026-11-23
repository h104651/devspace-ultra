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

---

## 二、尚未解決與待上線後驗收項目 (Pending / Operational Items)

| 項目說明 | 影響範圍 | 風險等級 | 是否阻擋 Merge | 是否阻擋 Production Deploy | 是否阻擋新 Agent 上線 | 說明 / 處置方式 |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **正式生產環境 Device Token 簽發** | 新 Windows 電腦 | Low | **否** | **否** | **是** | 依資安授權邊界，本輪禁止簽發正式憑證。需待 PR 合併並部署後，由管理員在安全管理介面手動簽發一次性 Token。 |
| **生產環境雙實機同時連線驗收** | 舊電腦與新電腦 | Low | **否** | **否** | **是** | 本機模擬測試（456 項）已全數 PASS，真實雙實機連線驗收需待正式部署完成後依 SOP 啟動。 |
| **ChatGPT MCP 端點實際對接測試** | ChatGPT 客戶端 | Low | **否** | **否** | **是** | 需於正式 Gateway 升級並加入第二台 Agent 後，由 ChatGPT 操作並指定 `targetDeviceId` 進行端對端驗收。 |

---

## 三、風險等級總評估 (Overall Risk Assessment)

- **代碼回歸風險**: **極低 (Very Low)**
  - 456 項全套自動化測試 100% 通過（連續三次確認無間歇性失敗）。
  - 單電腦環境保留自動綁定機制，100% 向後相容。
- **資料庫遷移風險**: **極低 (Very Low)**
  - SQLite 採非破壞性 `ALTER TABLE ADD COLUMN` 腳本，具備安全錯誤捕獲，不會損壞舊資料。
- **安全性與權限邊界**: **極高安全性 (Hardened Zero Trust)**
  - Scope 白名單、Idempotency 參數全校驗、Master Secret 嚴格隔離、已撤銷憑證永久失效。

---

## 四、最終決策建議 (Recommendation)

1. **GitHub PR Merge**: **建議核准 (READY TO MERGE)**。
   - 所有代碼修復、全套測試、審查文件已全數完成。
2. **正式生產部署**: **等待 ChatGPT 人工審核 (READY FOR PRODUCTION REVIEW)**。
   - 待 ChatGPT 與系統架構師確認本輪審查文件後，核准執行部署。
