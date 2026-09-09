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

    // Test 8: Default failTask is retryable according to existing default policy (cross-backend compatibility)
    const task3 = store.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { code: 'print(1)' }
    });
    store.claimTask('worker-1', ['kaggle:run']);
    const defaultFailRes = store.failTask(task3.taskId, { code: 'API_TIMEOUT', message: 'Kaggle backend timeout' });
    assert.strictEqual(defaultFailRes, true);
    const defaultFailedTask = store.getTask(task3.taskId);
    assert.ok(defaultFailedTask?.status === 'retrying' || defaultFailedTask?.status === 'queued', 'Default failTask must remain retryable (retrying or queued)');
    assert.strictEqual(defaultFailedTask?.completedAt, undefined, 'Retryable failure must NOT set completedAt');
    assert.strictEqual(defaultFailedTask?.retryPolicy.retryCount, 1, 'Default failure increments retryCount');
    assert.strictEqual(defaultFailedTask?.metadata?.lastRetryError?.code, 'API_TIMEOUT');
    assert.strictEqual(defaultFailedTask?.lease, undefined, 'Lease cleared on failure');
    passed++;

    // Test 9: Explicit terminal task failure (retryable: false)
    const task4 = store.createTask({
      backend: 'local',
      capability: 'local:write_file',
      payload: { path: 'b.txt', content: 'test' }
    });
    store.claimTask('device-1', ['local:write_file']);
    const terminalFailRes = store.failTask(task4.taskId, { code: 'WRITE_ERROR', message: 'Permission denied' }, { retryable: false });
    assert.strictEqual(terminalFailRes, true);
    const terminalFailedTask = store.getTask(task4.taskId);
    assert.strictEqual(terminalFailedTask?.status, 'failed', 'Explicit retryable:false must be terminal (status = failed)');
    assert.ok(terminalFailedTask?.completedAt, 'Terminal failure must set completedAt timestamp');
    assert.strictEqual(terminalFailedTask?.error?.code, 'WRITE_ERROR');
    assert.strictEqual(terminalFailedTask?.retryPolicy.retryCount, 0, 'Terminal failure must not increment retryCount');
    assert.strictEqual(terminalFailedTask?.lease, undefined, 'Terminal failure must clear lease');
    passed++;

    // Test 10: Explicit retryable task failure (retryable: true)
    const task5 = store.createTask({
      backend: 'local',
      capability: 'local:read_file',
      payload: { path: 'c.txt' }
    });
    store.claimTask('device-1', ['local:read_file']);
    const retryRes = store.failTask(task5.taskId, { code: 'NETWORK_TIMEOUT', message: 'Temporary network glitch' }, { retryable: true });
    assert.strictEqual(retryRes, true);
    const retryingTask = store.getTask(task5.taskId);
    assert.ok(retryingTask?.status === 'retrying' || retryingTask?.status === 'queued', 'Retryable failure must be retrying or queued');
    assert.strictEqual(retryingTask?.completedAt, undefined, 'Retryable failure must NOT set completedAt');
    assert.strictEqual(retryingTask?.retryPolicy.retryCount, 1, 'Retryable failure must increment retryCount');
    assert.strictEqual(retryingTask?.metadata?.lastRetryError?.code, 'NETWORK_TIMEOUT', 'Retryable error stored in metadata');
    assert.strictEqual(retryingTask?.lease, undefined, 'Retryable failure must clear lease for next attempt');
    passed++;

    // Test 11: Durable attempt ledger preserves execution history and enforces lease ownership.
    const task6 = store.createTask({
      backend: 'local',
      capability: 'local:read_file',
      payload: { path: 'attempt-ledger.txt' }
    });
    const firstAttemptClaim = store.claimTaskById(task6.taskId, 'device-attempt-1', 1000);
    assert.ok(firstAttemptClaim);
    const firstAttemptTask = store.getTask(task6.taskId) as any;
    assert.strictEqual(firstAttemptTask.attempts?.length, 1, 'Claim must create exactly one durable attempt');
    assert.ok(firstAttemptTask.activeAttemptId, 'Claim must bind one active attempt id');
    const firstAttemptId = firstAttemptTask.activeAttemptId;
    assert.strictEqual(firstAttemptTask.attempts[0].status, 'claimed');
    assert.strictEqual(firstAttemptTask.attempts[0].claimedBy, 'device-attempt-1');

    assert.strictEqual(store.acknowledgeTask(task6.taskId, 'device-attempt-1'), true);
    assert.strictEqual((store.getTask(task6.taskId) as any).attempts[0].status, 'acknowledged');

    assert.strictEqual(store.startTask(task6.taskId, 'wrong-device'), false, 'A non-owner must never start another worker\'s attempt');
    assert.strictEqual(store.getTask(task6.taskId)?.status, 'acknowledged', 'Rejected start must not mutate task state');
    assert.strictEqual(store.startTask(task6.taskId, 'device-attempt-1'), true);
    assert.strictEqual((store.getTask(task6.taskId) as any).attempts[0].status, 'running');

    assert.strictEqual(
      store.failTask(task6.taskId, { code: 'TRANSIENT', message: 'retry me' }, { retryable: true }),
      true
    );
    const afterFirstFailure = store.getTask(task6.taskId) as any;
    assert.strictEqual(afterFirstFailure.activeAttemptId, undefined, 'Finished retryable attempt must release active-attempt ownership');
    assert.strictEqual(afterFirstFailure.attempts[0].id, firstAttemptId);
    assert.strictEqual(afterFirstFailure.attempts[0].status, 'failed');
    assert.ok(afterFirstFailure.attempts[0].completedAt, 'Failed attempt must retain its completion timestamp');

    store.updateTask(task6.taskId, { status: 'queued' } as any);
    assert.ok(store.claimTaskById(task6.taskId, 'device-attempt-2', 1000));
    const secondAttemptTask = store.getTask(task6.taskId) as any;
    assert.strictEqual(secondAttemptTask.attempts.length, 2, 'Retry must append a new attempt instead of overwriting history');
    assert.notStrictEqual(secondAttemptTask.activeAttemptId, firstAttemptId, 'Retry must have a distinct active attempt id');
    assert.strictEqual(secondAttemptTask.attempts.filter((attempt: any) => ['claimed', 'acknowledged', 'running'].includes(attempt.status)).length, 1, 'A task may have only one active attempt');
    passed++;

    // Test 12: Stale recovery closes the active attempt as interrupted before requeue.
    const task7 = store.createTask({
      backend: 'local',
      capability: 'local:read_file',
      payload: { path: 'stale-attempt.txt' }
    });
    store.claimTaskById(task7.taskId, 'device-stale-attempt', 30);
    await new Promise(r => setTimeout(r, 50));
    const attemptRecovery = store.recoverStaleTasks();
    assert.ok(attemptRecovery.recoveredCount >= 1);
    const recoveredAttemptTask = store.getTask(task7.taskId) as any;
    assert.strictEqual(recoveredAttemptTask.status, 'queued');
    assert.strictEqual(recoveredAttemptTask.activeAttemptId, undefined);
    assert.strictEqual(recoveredAttemptTask.attempts?.length, 1);
    assert.strictEqual(recoveredAttemptTask.attempts[0].status, 'interrupted');
    assert.strictEqual(recoveredAttemptTask.attempts[0].errorCode, 'TASK_LEASE_EXPIRED');
    assert.ok(recoveredAttemptTask.attempts[0].completedAt);
    passed++;

    // Test 13: Event-driven wait resolves on task change and reports bounded timeout without polling.
    const task8 = store.createTask({
      backend: 'local',
      capability: 'local:git_status',
      payload: { repo: '.' }
    });
    store.claimTaskById(task8.taskId, 'device-wait', 1000);
    store.acknowledgeTask(task8.taskId, 'device-wait');
    store.startTask(task8.taskId, 'device-wait');

    const waitPromise = (store as any).waitForTask(task8.taskId, { timeoutMs: 500 });
    setTimeout(() => store.completeTask(task8.taskId, { waited: true }), 20);
    const waited = await waitPromise;
    assert.strictEqual(waited.timedOut, false);
    assert.strictEqual(waited.task.status, 'succeeded');
    assert.deepStrictEqual(waited.task.result, { waited: true });

    const task9 = store.createTask({
      backend: 'local',
      capability: 'local:git_status',
      payload: { repo: '.' }
    });
    const timedOut = await (store as any).waitForTask(task9.taskId, { timeoutMs: 25 });
    assert.strictEqual(timedOut.timedOut, true);
    assert.strictEqual(timedOut.task.status, 'queued');
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
