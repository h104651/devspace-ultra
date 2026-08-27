import * as assert from 'assert';
import * as fs from 'fs';
import { GatewayServer } from '../../src/gateway/server';

export async function runKaggleIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-kaggle';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const server = new GatewayServer({
    port: 0,
    host: '127.0.0.1',
    storageDir: testDir,
    masterSecret: 'test-secret',
    kaggleMockMode: true,
    kagglePollIntervalMs: 50
  });

  try {
    await server.start();

    // 1. Submit Kaggle Task
    const submitRes = await server.taskRouter.routeTaskSubmit(
      {
        backend: 'kaggle',
        capability: 'kaggle:run',
        payload: {
          kernelSlug: 'test-astor-train-poc',
          title: 'Astor Training POC Run',
          code: 'import torch\nprint("Training complete")',
          enableGpu: true,
          enableInternet: true
        }
      },
      ['kaggle:submit'],
      'chatgpt-kaggle-user'
    );

    assert.strictEqual(submitRes.status, 'running');
    passed++;

    // 2. Wait for background poller and completion
    let task = server.taskStore.getTask(submitRes.taskId);
    let attempts = 0;
    while (task?.status !== 'succeeded' && attempts < 40) {
      await new Promise(r => setTimeout(r, 100));
      task = server.taskStore.getTask(submitRes.taskId);
      attempts++;
    }

    assert.strictEqual(task?.status, 'succeeded', 'Kaggle task should complete successfully in mock mode');
    assert.strictEqual(task?.result?.status, 'complete');
    passed++;

    // 3. Verify Artifacts downloaded and recorded
    const artifacts = server.artifactStore.getTaskArtifacts(submitRes.taskId);
    assert.ok(artifacts.length >= 2, 'Should have stdout.log and result.json artifacts');
    const stdoutArt = artifacts.find(a => a.name === 'stdout.log');
    assert.ok(stdoutArt, 'stdout.log should exist');
    assert.ok(stdoutArt?.preview?.includes('Mock Kaggle output stdout'));
    passed++;
  } catch (err: any) {
    console.error('Kaggle integration test failed:', err);
    failed++;
  } finally {
    await server.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
