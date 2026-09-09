import * as assert from 'assert';
import { TaskStore } from '../../src/storage/task-store';

export async function runTaskLogRetentionUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const store = new TaskStore();
    const task = store.createTask({
      backend: 'local',
      capability: 'local:git_status',
      payload: { repo: '.' }
    });

    const lines = Array.from({ length: 2500 }, (_, index) => `diagnostic-line-${index}`);
    store.appendLogs(task.taskId, lines);

    const retained = store.getTask(task.taskId)?.logs || [];
    assert.ok(retained.length <= 2000, `Task logs must be bounded; retained ${retained.length} lines`);
    assert.ok(retained[0]?.includes('[LOG_RETENTION]'), 'Truncated history must leave an explicit retention marker');
    assert.ok(retained[retained.length - 1]?.includes('diagnostic-line-2499'), 'Newest task logs must be preserved');
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Task log retention remains bounded while preserving newest diagnostics\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
