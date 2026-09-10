import * as assert from 'assert';
import { TaskStore } from '../../src/storage/task-store';

function legacyRunningTask(taskId: string, now: number): any {
  return {
    taskId,
    backend: 'local',
    capability: 'local:read_file',
    requiredScope: 'local:read',
    status: 'running',
    priority: 0,
    payload: { path: 'legacy.txt' },
    retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 1000, requeueOnStale: true },
    lease: {
      claimedBy: 'legacy-device',
      claimedAt: now - 1000,
      acknowledgedAt: now - 900,
      leaseExpiresAt: now + 60000,
      lastHeartbeatAt: now - 100
    },
    artifacts: [],
    logs: [],
    startedAt: now - 800,
    createdAt: now - 1200,
    updatedAt: now - 100
  };
}

export async function runTaskAttemptMigrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const now = Date.now();
    const store = new TaskStore();
    store.hydrate([legacyRunningTask('legacy-complete', now)]);

    const before = store.getTask('legacy-complete') as any;
    assert.deepStrictEqual(before.attempts, [], 'Pre-ledger in-flight task should hydrate without inventing history prematurely');

    assert.strictEqual(store.completeTask('legacy-complete', { ok: true }), true);
    const completed = store.getTask('legacy-complete') as any;
    assert.strictEqual(completed.status, 'succeeded');
    assert.strictEqual(completed.attempts?.length, 1, 'Terminal completion must backfill the authoritative legacy in-flight attempt');
    assert.strictEqual(completed.attempts[0].claimedBy, 'legacy-device');
    assert.strictEqual(completed.attempts[0].status, 'succeeded');
    assert.strictEqual(completed.attempts[0].startedAt, before.startedAt);
    assert.ok(completed.attempts[0].completedAt);
    assert.strictEqual(completed.activeAttemptId, undefined);

    const failedStore = new TaskStore();
    failedStore.hydrate([legacyRunningTask('legacy-fail', now)]);
    assert.strictEqual(
      failedStore.failTask('legacy-fail', { code: 'LEGACY_FAIL', message: 'legacy execution failed' }, { retryable: false }),
      true
    );
    const failed = failedStore.getTask('legacy-fail') as any;
    assert.strictEqual(failed.attempts?.length, 1, 'Terminal failure must also backfill the legacy attempt');
    assert.strictEqual(failed.attempts[0].status, 'failed');
    assert.strictEqual(failed.attempts[0].errorCode, 'LEGACY_FAIL');
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Legacy in-flight tasks backfill attempt history on terminal transition\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
