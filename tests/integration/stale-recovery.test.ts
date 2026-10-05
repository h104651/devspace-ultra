import * as assert from 'assert';
import * as fs from 'fs';
import { GatewayServer } from '../../src/gateway/server';

export async function runStaleRecoveryIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-stale';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const server = new GatewayServer({
    storageDir: testDir,
    masterSecret: 'test-secret'
  });

  try {
    // 1. Create a task with a 50ms lease
    const task = server.taskStore.createTask({
      backend: 'local',
      capability: 'local:test',
      payload: { cmd: 'run' },
      maxRetries: 2
    });

    // 2. Claim by worker
    server.taskStore.claimTask('crashed-worker', ['local:test'], 50);
    assert.strictEqual(server.taskStore.getTask(task.taskId)?.status, 'claimed');
    passed++;

    // 3. Wait for lease to expire
    await new Promise(r => setTimeout(r, 80));

    // 4. Run LeaseMonitor tick
    server.leaseMonitor.tick();

    // 5. Verify task is recovered back to queued
    const recoveredTask = server.taskStore.getTask(task.taskId);
    assert.strictEqual(recoveredTask?.status, 'queued', 'Task should be requeued after worker disappearance');
    assert.strictEqual(recoveredTask?.retryPolicy.retryCount, 1);
    passed++;

    // 6. Claim and expire remaining retries
    server.taskStore.claimTask('crashed-worker-2', ['local:test'], 50);
    await new Promise(r => setTimeout(r, 80));
    server.leaseMonitor.tick(); // retryCount = 2

    server.taskStore.claimTask('crashed-worker-3', ['local:test'], 50);
    await new Promise(r => setTimeout(r, 80));
    server.leaseMonitor.tick(); // max retries exceeded -> stale terminal status

    const terminalTask = server.taskStore.getTask(task.taskId);
    assert.strictEqual(terminalTask?.status, 'stale', 'Should transition to stale status after exceeding max retries');
    passed++;
  } catch (err: any) {
    console.error('Stale recovery test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
