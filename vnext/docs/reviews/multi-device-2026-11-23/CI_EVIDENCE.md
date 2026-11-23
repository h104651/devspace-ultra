# DevSpace Ultra vNext — GitHub Actions CI 執行與驗收證據

## 一、原始 CI 失敗紀錄 (Original Failed Run)

- **Workflow 名稱**: `vNext CI & Production Deploy`
- **Workflow Run ID**: `45094126539`
- **觸發來源**: `pull_request` (PR #23)
- **Commit SHA**: `3b99dc51ef740000dc2f44db9ea7d62d9a4bb327`
- **完整 URL**: [https://github.com/h104651/devspace-ultra/actions/runs/45094126539](https://github.com/h104651/devspace-ultra/actions/runs/45094126539)
- **結論**: `FAILED` (Process completed with exit code 1)
- **失敗 Job**: `verify-vnext`
- **失敗 Step**: `Unit, integration, protocol and security tests`
- **日誌節錄**:
  ```text
  ▶ Running Integration: Multi-Device Targeted Routing & Registration
    FAIL: Task B7: Task lease expiration and retry preserves targetDeviceId binding
    AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
      assert.ok(rec.recoveredCount >= 1)
        at async /home/runner/work/devspace-ultra/devspace-ultra/vnext/tests/integration/multi-device-routing.test.ts:571:14
        at async test (/home/runner/work/devspace-ultra/devspace-ultra/vnext/tests/integration/multi-device-routing.test.ts:112:7)
  ====================================================
  Total Tests Passed: 452
  Total Tests Failed: 1
  ====================================================
  ##[error]Process completed with exit code 1.
  ```

---

## 二、本次修復後本機驗收結果 (Local Verification)

- **執行環境**: Windows 11 (ARM64 Workstation)
- **Node.js**: v24.18.0
- **TypeScript 建置 (`npm run build`)**: PASS (Exit code 0)
- **連續三次完整測試回歸**:
  - Run 1: 456 Passed / 0 Failed (Exit code 0)
  - Run 2: 456 Passed / 0 Failed (Exit code 0)
  - Run 3: 456 Passed / 0 Failed (Exit code 0)
- **Wrangler Deploy 預檢 (`npx wrangler deploy --dry-run`)**: PASS (Exit code 0)
- **關鍵修復項目驗證**:
  - `Task B7`: 驗證即時 Agent 輪詢環境下租約逾期回收成功，重試次數累加，目標電腦正確認領第二個 Attempt。
  - `Task B7b`: 隔離環境下驗證 `recoveredCount === 1`、非目標裝置無法搶奪、連續逾期直至重試上限轉為 terminal `stale` 狀態。
  - `Task B13`: 驗證 Idempotency 參數衝突檢驗與無權限調用者拒絕繞過。
  - `Task B14`: 驗證 5 種裝置註冊/在線狀態的定向路由與安全保護。

---

## 三、待遠端 CI 驗證步驟

本輪所有代碼與文件經 Git Commit 與 Push 至 `origin/feature/multi-device-targeted-routing` 後：
1. GitHub Actions 將自動觸發 PR #23 的 CI 流程。
2. 驗證 Linux Runner 環境下 `vNext CI & Production Deploy` 中的 Verify 流程是否轉為全綠燈 PASS。
3. 確認 PR 為 Draft 狀態，生產部署 Step 未被觸發（保持安全）。
