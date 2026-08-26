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
