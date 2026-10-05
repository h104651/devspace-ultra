import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KaggleClient } from '../src/kaggle/client';
import { KaggleTaskPayload } from '../src/types/kaggle';

async function main() {
  console.log('====================================================');
  console.log('       DevSpace Ultra — Real Kaggle Smoke Test      ');
  console.log('====================================================\n');

  const kaggleJsonPath = path.join(os.homedir(), '.kaggle', 'kaggle.json');
  const hasKaggleJson = fs.existsSync(kaggleJsonPath);
  const hasEnvVars = Boolean(process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY);

  if (!hasKaggleJson && !hasEnvVars) {
    console.log('\x1b[33mREAL KAGGLE TEST: BLOCKED — credential not configured\x1b[0m\n');
    console.log('To unblock real Kaggle integration:');
    console.log('  1. Obtain your API token from https://www.kaggle.com/settings -> "Create New Token"');
    console.log('  2. Run: node scripts/setup-kaggle-credentials.js');
    console.log('  3. Re-run this smoke test.\n');
    process.exit(0);
  }

  console.log('[1/5] Kaggle credentials found. Authenticating...');
  const client = new KaggleClient(); // Real mode

  const tempDir = path.join(os.tmpdir(), `kaggle-smoke-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const kernelSlug = `devspace-smoke-${Date.now()}`;
    const code = `
import sys
print("DevSpace Ultra Kaggle Real Smoke Test PASS")
with open("result.json", "w") as f:
    f.write('{"status": "ok", "test": "smoke_pass"}')
`;

    console.log('[2/5] Packaging minimal test kernel (CPU mode)...');
    const payload: KaggleTaskPayload = {
      kernelSlug,
      title: 'DevSpace Ultra Smoke Test',
      code,
      enableGpu: false,
      enableInternet: true
    };

    console.log(`[3/5] Pushing kernel '${kernelSlug}' to Kaggle API...`);
    const pushResult = await client.pushKernel(tempDir, payload);
    if (!pushResult.success) {
      throw new Error(`Push failed: ${pushResult.error}`);
    }
    console.log(`      Kernel pushed: ${pushResult.kernelUrl}`);

    console.log('[4/5] Polling remote kernel execution status...');
    let isComplete = false;
    let attempts = 0;
    while (!isComplete && attempts < 40) {
      await new Promise(r => setTimeout(r, 10000)); // 10s poll
      const statusRes = await client.getKernelStatus(kernelSlug);
      console.log(`      Remote Status: ${statusRes.status}`);

      if (statusRes.status === 'complete') {
        isComplete = true;
      } else if (statusRes.status === 'error' || statusRes.status === 'cancelled') {
        throw new Error(`Kaggle execution failed with status: ${statusRes.status} (${statusRes.rawMessage || ''})`);
      }
      attempts++;
    }

    if (!isComplete) {
      throw new Error('Timed out waiting for Kaggle smoke test to complete');
    }

    console.log('[5/5] Downloading logs and output artifacts...');
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputs = await client.downloadKernelOutput(kernelSlug, outputDir);
    if (!outputs.success) {
      throw new Error(`Failed to download output: ${outputs.error}`);
    }

    console.log('\n====================================================');
    console.log('\x1b[32mReal Kaggle authentication   : PASS\x1b[0m');
    console.log('\x1b[32mReal notebook submission     : PASS\x1b[0m');
    console.log('\x1b[32mRemote status retrieval      : PASS\x1b[0m');
    console.log('\x1b[32mRemote logs retrieval        : PASS\x1b[0m');
    console.log('\x1b[32mArtifact/result retrieval    : PASS\x1b[0m');
    console.log('\x1b[32mREAL KAGGLE TEST             : PASS\x1b[0m');
    console.log('====================================================\n');
  } catch (err: any) {
    console.error('\n\x1b[31mREAL KAGGLE TEST: FAILED\x1b[0m');
    console.error(err.message);
    process.exit(1);
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main();
