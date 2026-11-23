# DevSpace Ultra vNext — 全套回歸測試矩陣與執行證據

## 一、測試環境摘要

- **作業系統**: Windows 11 (ARM64)
- **Node.js 版本**: v24.18.0
- **npm 版本**: 11.6.0
- **TypeScript 建置**: `npm run build` (tsc) -> Exit code: 0
- **測試命令**: `npm test` (`ts-node tests/run-all-tests.ts`)
- **Cloudflare 預檢**: `npx --yes wrangler@4.129.0 deploy --dry-run` -> Exit code: 0

---

## 二、測試套件執行結果總覽 (Test Suites Breakdown)

| 序號 | 測試套件名稱 (Test Suite) | 測試類型 | 案例數 | 結果 | 執行耗時 | 備註 / 驗證重點 |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| 1 | Unit: Auth & Token Management | 單元測試 | 6 | PASS | 4ms | Token 簽發、驗證、Scope、撤銷 |
| 2 | Unit: Scopes & Permissions | 單元測試 | 4 | PASS | 0ms | ScopeChecker、權限層級與要求檢查 |
| 3 | Unit: Task State & Transitions | 單元測試 | 13 | PASS | 231ms | 狀態機轉換、認領、取消、重試 |
| 4 | Unit: Legacy In-Flight Attempt Migration | 單元測試 | 1 | PASS | 1ms | 歷史任務嘗試記錄向後相容水合 |
| 5 | Unit: Bounded Task Log Retention | 單元測試 | 1 | PASS | 6ms | 日誌筆數與位元組大小邊界保護 |
| 6 | Unit: Secret & PII Redactor | 單元測試 | 3 | PASS | 1ms | 機密過濾、憑證遮罩、日誌脫敏 |
| 7 | Unit: Path Sanitizer & Sandbox | 單元測試 | 4 | PASS | 0ms | 路徑周遊防禦、跨目錄讀寫防護 |
| 8 | Unit: Artifacts & Integrity | 單元測試 | 4 | PASS | 4ms | 產出物校驗和、元數據持久化 |
| 9 | Unit: Local Project Registry & Path Security | 單元測試 | 22 | PASS | 14ms | 專案目錄安全、即時熱重載 |
| 10 | Unit: Local Agent Environment Probe Capabilities | 單元測試 | 2 | PASS | 422ms | 探針偵測、本機能力動態回報 |
| 11 | Unit: Device Status Live Capabilities & Eligibility | 單元測試 | 7 | PASS | 2ms | 裝置線上狀態與能力過濾 |
| 12 | Unit: Local Fast Tools Bounded Direct Results | 單元測試 | 15 | PASS | 1630ms | 快速工具直接回傳與短超時控制 |
| 13 | Protocol: MCP 2026-07-28 Wire Validation | 協定測試 | 11 | PASS | 18ms | MCP 現代與相容協定訊息規範 |
| 14 | Integration: Gateway Flow (REST + WS Agent) | 整合測試 | 3 | PASS | 454ms | 端到端 REST 提交與 Agent 認領執行 |
| 15 | Integration: Remote MCP Transport (HTTP POST /mcp) | 整合測試 | 8 | PASS | 68ms | /mcp 端點工具調用與 OAuth 攔截 |
| 16 | Integration: Agent Lifecycle & Durability | 整合測試 | 19 | PASS | 1597ms | Agent 斷線、重連、心跳與清理 |
| 17 | Integration: Local Multi-Project Named Routing | 整合測試 | 29 | PASS | 804ms | 具名專案路由與許可權控制 |
| 18 | **Integration: Multi-Device Targeted Routing & Registration** | **整合測試** | **34** | **PASS** | **2065ms** | **本次修復重點 (含 A1~A8, B1~B25)** |
| 19 | Integration: Local Workspace Discovery & Nested Operations | 整合測試 | 15 | PASS | 42104ms | 遞迴工作區探索與檔案列舉 |
| 20 | Integration: Kaggle Mock Backend | 整合測試 | 3 | PASS | 116ms | Kaggle 模擬後端執行 |
| 21 | Integration: Pre-Migration Kaggle Restart Recovery | 整合測試 | 1 | PASS | 1ms | 遷移前歷史重啟恢復 |
| 22 | Integration: Kaggle Persistent Project Control v1 | 整合測試 | 100 | PASS | 18ms | Kaggle 專案生命週期與指令控制 |
| 23 | Integration: Kaggle Large Project Workspace Mode | 整合測試 | 34 | PASS | 14476ms | 大型專案工作區模式 |
| 24 | Integration: Kaggle Dataset File Direct Read | 整合測試 | 18 | PASS | 4ms | 資料集直讀支援 |
| 25 | Integration: Kaggle Durable Persistence & Cold-Start Reconcile | 整合測試 | 12 | PASS | 196ms | 冷啟動水合與狀態調和 |
| 26 | Integration: Chat Swarm & Wake Bridge | 整合測試 | 4 | PASS | 3ms | Swarm 協同工作流喚醒 |
| 27 | Integration: Stale Task Recovery | 整合測試 | 3 | PASS | 275ms | 逾期租約定期回收 |
| 28 | Integration: Idempotency & Replays | 整合測試 | 4 | PASS | 6ms | 基礎冪等請求快取驗證 |
| 29 | Cloudflare: Workers Runtime & SQLite DO & R2 Adapter | Cloudflare | 12 | PASS | 16ms | SQLite 本機模擬與 DO 互動 |
| 30 | Cloudflare: Non-destructive Recovery Singleton Routing | Cloudflare | 1 | PASS | 0ms | 恢復單例平滑路由 |
| 31 | Cloudflare: Production remote_task_wait MCP Surface | Cloudflare | 2 | PASS | 2ms | 等待端點對外介面 |
| 32 | Cloudflare: Durable Task Execution Metadata Persistence | Cloudflare | 1 | PASS | 6ms | 執行元數據存儲 |
| 33 | Cloudflare: R2 Cost Guard & Hard Quota Limits | Cloudflare | 21 | PASS | 22ms | R2 成本守門員與配額硬上限 |
| 34 | Cloudflare: Browser Swarm E2E & DO Restart | Cloudflare | 5 | PASS | 20ms | 瀏覽器群集與 DO 重啟容錯 |
| 35 | Cloudflare: Chat Swarm Durable Storage Efficiency | Cloudflare | 4 | PASS | 25ms | 存儲空間壓縮與效率測試 |
| 36 | Cloudflare: Cold-Start Storage Efficiency & Lazy History | Cloudflare | 3 | PASS | 2ms | 冷啟動歷史記錄惰性載入 |
| 37 | Cloudflare: MCP OAuth Insufficient-Scope Step-Up | Cloudflare | 3 | PASS | 3ms | OAuth 權限不足提權流程 |
| 38 | Cloudflare: OAuth 2.1 & Protected Resource Metadata | Cloudflare | 20 | PASS | 2ms | OAuth 2.1 協定與安全端點元數據 |
| 39 | Security: Zero Trust, Injections, Shell & Rate Limits | 安全測試 | 13 | PASS | 79ms | 零信任防護、指令注入、頻率限制 |
| 40 | Security: Bootstrap Token Security & Redaction | 安全測試 | 3 | PASS | 2ms | 開機引導憑證安全脫敏 |
| 41 | **Unit: Read-Only Task Inventory & Preflight Verification** | **單元測試** | **53** | **PASS** | **11ms** | **Task 2 唯讀任務盤點 CLI、舊版 DO 偵測、Data Studio SQL、Schema 嚴格校驗** |
| 42 | **Unit: GitHub Actions Deployment Gate & Authorization** | **單元測試** | **32** | **PASS** | **4ms** | **Task 3 PR Merge 與生產部署完全解耦、環境變數安全傳遞與 40-char SHA 鎖定門禁** |
| **總計** | **42 個測試套件** | — | **553** | **PASS** | **約 67 秒** | **成功率 100% (0 失敗)** |

---

## 三、多裝置路由專項測試細項 (Multi-Device Routing Suite)

| 測試編號 | 測試案例說明 | 驗證目標 | 結果 |
| :--- | :--- | :--- | :---: |
| **Task A1** | DO POST /admin/devices requires valid ADMIN_SECRET | 驗證無認證、錯誤密鑰、MASTER_SECRET 提權均遭拒絕 | PASS |
| **Task A2** | DO POST /admin/devices registers new device with independent ID and single-use token | 簽發獨立 deviceId 與專用 Token，Token 僅呈現一次 | PASS |
| **Task A3** | DO SQLite persistence survives durable restart | 重啟 Durable Object 水合後裝置與 Token 雜湊正確復原 | PASS |
| **Task A4** | Non-admin token cannot register device | 缺乏 admin 權限的客戶端禁止調用裝置註冊 API | PASS |
| **Task A5** | Revoked device immediately rejected upon validation | 撤銷裝置後其所屬 Token 立即失效（DEVICE_REVOKED） | PASS |
| **Task A6** | Device registration validates input, limits expiresInMs and rejects non-whitelisted scopes | 阻擋提權 Scope（admin/tasks:submit）、限制有效期 60s..365d、過濾 ID 惡意字元 | PASS |
| **Task A7** | Re-registering a previously revoked device ID permanently invalidates the old token | 撤銷後同 ID 重新註冊，舊 Token 保持永久失效（TOKEN_REVOKED / TOKEN_SUPERSEDED） | PASS |
| **Task A8** | Device registration defaults to minimal read-only scopes and sets no-store cache headers | 省略 capabilities 時預設為最小唯讀範圍（local:read, artifacts:read），回應包含 Cache-Control: no-store | PASS |
| **Task B1** | Two agents connected simultaneously are correctly identified in device_status | 兩台電腦同時在線時，Gateway 明確列出各自獨立 ID 與狀態 | PASS |
| **Task B2** | Task targeted to New PC is claimed and completed strictly by New PC | 指定新電腦的任務僅由新電腦認領與完成 | PASS |
| **Task B3** | Task targeted to Old PC is claimed and completed strictly by Old PC | 指定舊電腦的任務僅由舊電腦認領與完成 | PASS |
| **Task B4** | Old PC cannot steal task targeted to New PC | 舊電腦無法認領排隊中指定給新電腦的任務 | PASS |
| **Task B5** | Ambiguous dispatch rejection: when multiple agents online, omitting targetDeviceId throws AMBIGUOUS_DEVICE_TARGET | 多台在線且未指明目標時，拒絕模糊分派（Fail Closed） | PASS |
| **Task B6** | When target device is offline, task remains queued and is not reassigned to online device | 目標離線時任務保持排隊，嚴禁自動改派線上它機 | PASS |
| **Task B7** | Task lease expiration and retry preserves targetDeviceId binding | 即時在線環境下租約逾期回收，目標綁定不遺失，新電腦可合法領取 Attempt 2 | PASS |
| **Task B7b** | Deterministic TaskStore lease recovery and retry exhaustion in isolation | 隔離環境驗證精準回收計數（recoveredCount: 1）、重試累加與耗盡轉 terminal stale | PASS |
| **Task B8** | Revoked device is immediately disconnected and rejected upon polling | 撤銷裝置後主動切斷 WebSocket，阻止後續輪詢認領 | PASS |
| **Task B9** | Zero online agents but multiple registered devices: omitting targetDeviceId throws AMBIGUOUS_DEVICE_TARGET | 0台在線但多台已註冊時，未指定裝置之任務拒絕排隊 | PASS |
| **Task B10** | Zero online agents and single registered device: auto-binds targetDeviceId safely | 0台在線但僅有1台註冊時，安全自動綁定該裝置 | PASS |
| **Task B11** | Idempotency Replay: reusing idempotencyKey across different targetDeviceId throws IDEMPOTENCY_CONFLICT | 相同 idempotencyKey 指定不同裝置時拒絕執行 | PASS |
| **Task B12** | Legacy unassigned tasks are safely migrated and fail closed when ambiguous in multi-device environment | 歷史任務安全遷移：單裝置綁定、歷史認領保留、多裝置時 Fail Closed（AMBIGUOUS_LEGACY_TASK） | PASS |
| **Task B13** | Full Idempotency conflict matrix on parameters and authorization enforcement | 完整比對 targetDeviceId、backend、capability、payload 衝突，且無權限無法透過 Replay 繞過授權 | PASS |
| **Task B14** | Five distinct device states routing security matrix | 驗證 5 種裝置註冊/連線狀態之定向路由與安全防護 | PASS |
| **Task B15** | Strict P0 verification of legacy unassigned tasks, zero-device cold start, and claim protections | 覆蓋 10 項邊界檢驗：無綁定拒絕認領、歷史認領者自動綁定、單裝置自動綁定、多裝置/0裝置 fail-closed 標記 failed、SQLite 持久化與 Durable Object 冷啟動路徑 | PASS |
| **Task B16** | Old agent Bootstrap Token compatibility and prohibition of re-registration | 驗證舊 Agent 使用 Bootstrap Token 上線相容性、重連保持有效、禁止管理端以同 ID 補登（拋出 DEVICE_ID_CONFLICT），及撤銷重註冊導致舊憑證失效（TOKEN_SUPERSEDED）之資安驗證 | PASS |
| **Task B17** | Gateway cold start with zero registered devices preserves legacy queued tasks until single agent reconnects | 驗證 0 註冊裝置冷啟動時非破壞性保留未綁定任務於 queued 隔離狀態，防止任何 Agent 偷領；嚴格禁止依連線自動綁定，需待管理員明確指派（Zero Task Loss 且無自動掠奪） | PASS |
| **Task B18** | New device connecting first must NOT acquire quarantined unassigned legacy tasks | 新裝置先上線時絕不自動獲取歷史未指派任務，任務嚴格維持在 queued 隔離狀態，任何裝置均無法領取（Task 1 防冒領保證） | PASS |
| **Task B19** | Old device connecting first only claims tasks with verifiable prior claimant | 舊裝置先上線時僅能領取歷史 lease/attempts 證明曾由其認領之任務，無證明之任務維持隔離待管理員指派 | PASS |
| **Task B20** | New device registered while old device offline cannot claim quarantined tasks | 新裝置註冊且舊裝置離線時，新裝置輪詢或按 ID 領取隔離中舊任務一律遭拒絕（Fail Closed） | PASS |
| **Task B21** | Simultaneous multi-device reconnection preserves targetDeviceId separation | 雙機同時重新連線時，嚴格維護各自 targetDeviceId 獨立路由，隔離中任務保持不可認領 | PASS |
| **Task B22** | Quarantined legacy tasks require explicit admin assignment via POST /admin/tasks/assign-legacy | 隔離佇列中之歷史任務需經由具備 ADMIN_SECRET 之管理端 API 提供非空 taskIds 明確指派至有效已註冊裝置 | PASS |
| **Task B23** | Durable Object cold start preserves quarantined tasks without auto-binding | Gateway Durable Object 冷啟動水合時，歷史無認領記錄之任務安全維持在 queued 隔離狀態，絕不依賴連線自動綁定 | PASS |
| **Task B24** | Multi-device disconnect, lease expiration, and stale recovery strictly preserves targetDeviceId | 多裝置斷線與租約過期回收情境下，targetDeviceId 與隔離狀態完全保留，重試計數正確累加 | PASS |
| **Task B25** | Active Task Status Whitelisting and Terminal Task Assignment Exclusion | 驗證 Active 任務狀態白名單（queued, claimed, acknowledged, running, retrying），排除終態（succeeded, failed, cancelled, stale）；指派 API 嚴格禁止修改終態歷史任務 | PASS |

---

## 四、連續 3 次完整測試執行紀錄 (Regression Consistency)

依規範連續執行三次完整測試套件，確認無間歇性失敗 (Flaky Tests)：

1. **第一次完整執行**:
   - 測試案例: 553 Passed / 0 Failed
   - Exit Code: 0
   - 執行耗時: 66,742 ms
2. **第二次完整執行**:
   - 測試案例: 553 Passed / 0 Failed
   - Exit Code: 0
   - 執行耗時: 65,910 ms
3. **第三次完整執行**:
   - 測試案例: 553 Passed / 0 Failed
   - Exit Code: 0
   - 執行耗時: 66,120 ms

---

## 五、Wrangler Deploy Dry-Run 檢驗結果

```text
 ⛅️ wrangler 4.129.0 (update available 4.166.0)
───────────────────────────────────────────────
Total Upload: 464.73 KiB / gzip: 93.14 KiB
Your Worker has access to the following bindings:
Binding                                                  Resource                  
env.GATEWAY_DO (GatewayDurableObject)                    Durable Object            
env.ARTIFACTS_R2 (devspace-ultra-artifacts)              R2 Bucket                 
env.R2_MAX_TOTAL_BYTES ("2147483648")                    Environment Variable      
env.R2_MAX_OBJECT_BYTES ("20971520")                     Environment Variable      
env.R2_MAX_OBJECT_COUNT ("2000")                         Environment Variable      
env.R2_MAX_CLASS_A_MONTH ("100000")                      Environment Variable      
env.R2_MAX_CLASS_B_MONTH ("1000000")                     Environment Variable      
env.R2_RETENTION_DAYS ("7")                              Environment Variable      

--dry-run: exiting now.
```
- **狀態**: SUCCESS (Exit code 0)
- **分析**: 代碼打包無缺漏模組，Durable Object 與 R2 Bucket 綁定完整。
