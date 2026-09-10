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

    const hugeUtf8Line = '🚀'.repeat(5000);
    store.appendLogs(task.taskId, [hugeUtf8Line]);
    const afterHugeLine = store.getTask(task.taskId)?.logs || [];
    const newest = afterHugeLine[afterHugeLine.length - 1] || '';
    assert.ok(Buffer.byteLength(newest, 'utf8') <= 4096, `Individual retained log entry must be <= 4096 UTF-8 bytes; got ${Buffer.byteLength(newest, 'utf8')}`);
    assert.ok(newest.includes('[LOG_LINE_TRUNCATED]'), 'Byte-truncated log entry must carry an explicit marker');
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Task log retention remains bounded by entry count and UTF-8 bytes\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
