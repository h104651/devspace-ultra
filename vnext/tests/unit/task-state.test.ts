import * as assert from 'assert';
import * as fs from 'fs';
import { TaskStore } from '../../src/storage/task-store';

export async function runTaskStateUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-taskstate';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  try {
    const store = new TaskStore(testDir, 1000); // 1 sec default lease for fast testing

    // Test 1: Task creation
    const task = store.createTask({
      backend: 'local',
      capability: 'local:git_status',
      payload: { repo: '.' }
    });
    assert.strictEqual(task.status, 'queued');
    passed++;

    // Test 2: Claim task
    const claimed = store.claimTask('device-1', ['local:git_status'], 500);
    assert.ok(claimed);
    assert.strictEqual(claimed?.taskId, task.taskId);
    assert.strictEqual(claimed?.status, 'claimed');
    assert.strictEqual(claimed?.lease?.claimedBy, 'device-1');
    passed++;

    // Test 3: Acknowledge task
    const ack = store.acknowledgeTask(task.taskId, 'device-1');
    assert.strictEqual(ack, true);
    assert.strictEqual(store.getTask(task.taskId)?.status, 'acknowledged');
    passed++;

    // Test 4: Start running task
    const started = store.startTask(task.taskId, 'device-1');
    assert.strictEqual(started, true);
    assert.strictEqual(store.getTask(task.taskId)?.status, 'running');
    passed++;

    // Test 5: Renew lease
    const renewed = store.renewLease(task.taskId, 'device-1', 2000);
    assert.strictEqual(renewed, true);
    passed++;

    // Test 6: Complete task
    const completed = store.completeTask(task.taskId, { clean: true });
    assert.strictEqual(completed, true);
    const finalized = store.getTask(task.taskId);
    assert.strictEqual(finalized?.status, 'succeeded');
    assert.deepStrictEqual(finalized?.result, { clean: true });
    assert.strictEqual(finalized?.lease, undefined);
    passed++;

    // Test 7: Stale detection and requeue
    const task2 = store.createTask({
      backend: 'local',
      capability: 'local:read_file',
      payload: { path: 'a.txt' }
    });
    store.claimTask('device-dead', ['local:read_file'], 50); // 50ms lease
    await new Promise(r => setTimeout(r, 80)); // Wait for lease to expire

    const recovery = store.recoverStaleTasks();
    assert.strictEqual(recovery.recoveredCount, 1, 'Should recover 1 stale task back to queued');
    assert.strictEqual(store.getTask(task2.taskId)?.status, 'queued');
    assert.strictEqual(store.getTask(task2.taskId)?.retryPolicy.retryCount, 1);
    passed++;

    // Test 8: Default task failure is terminal
    const task3 = store.createTask({
      backend: 'local',
      capability: 'local:write_file',
      payload: { path: 'b.txt', content: 'test' }
    });
    store.claimTask('device-1', ['local:write_file']);
    const failRes = store.failTask(task3.taskId, { code: 'WRITE_ERROR', message: 'Permission denied' });
    assert.strictEqual(failRes, true);
    const failedTask = store.getTask(task3.taskId);
    assert.strictEqual(failedTask?.status, 'failed', 'Default failTask must be terminal (status = failed)');
    assert.ok(failedTask?.completedAt, 'Terminal failure must set completedAt timestamp');
    assert.strictEqual(failedTask?.error?.code, 'WRITE_ERROR');
    assert.strictEqual(failedTask?.retryPolicy.retryCount, 0, 'Terminal failure must not increment retryCount');
    assert.strictEqual(failedTask?.lease, undefined, 'Terminal failure must clear lease');
    passed++;

    // Test 9: Explicit retryable task failure
    const task4 = store.createTask({
      backend: 'local',
      capability: 'local:read_file',
      payload: { path: 'c.txt' }
    });
    store.claimTask('device-1', ['local:read_file']);
    const retryRes = store.failTask(task4.taskId, { code: 'NETWORK_TIMEOUT', message: 'Temporary network glitch' }, { retryable: true });
    assert.strictEqual(retryRes, true);
    const retryingTask = store.getTask(task4.taskId);
    assert.ok(retryingTask?.status === 'retrying' || retryingTask?.status === 'queued', 'Retryable failure must be retrying or queued');
    assert.strictEqual(retryingTask?.completedAt, undefined, 'Retryable failure must NOT set completedAt');
    assert.strictEqual(retryingTask?.retryPolicy.retryCount, 1, 'Retryable failure must increment retryCount');
    assert.strictEqual(retryingTask?.metadata?.lastRetryError?.code, 'NETWORK_TIMEOUT', 'Retryable error stored in metadata');
    assert.strictEqual(retryingTask?.lease, undefined, 'Retryable failure must clear lease for next attempt');
    passed++;
  } catch (err: any) {
    console.error('Task state test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
