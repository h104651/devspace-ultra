import * as assert from 'assert';
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';
import { TaskStore } from '../../src/storage/task-store';

class DurableTaskSqlMock implements SqlStorage {
  private taskRows = new Map<string, Record<string, any>>();
  public alters: string[] = [];

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const normalized = query.trim();
    const upper = normalized.toUpperCase();
    const empty = { toArray: () => [], one: () => null, raw: () => null };

    if (upper.startsWith('ALTER TABLE')) {
      this.alters.push(normalized.replace(/\s+/g, ' '));
      return empty;
    }

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE INDEX')) {
      return empty;
    }

    if (upper.startsWith('INSERT OR REPLACE INTO TASKS')) {
      const columnMatch = normalized.match(/INSERT OR REPLACE INTO tasks\s*\(([\s\S]*?)\)\s*VALUES/i);
      if (!columnMatch) throw new Error('Unable to parse task INSERT columns');
      const columns = columnMatch[1].split(',').map(column => column.trim());
      const row: Record<string, any> = {};
      columns.forEach((column, index) => { row[column] = params[index]; });
      this.taskRows.set(String(row.taskId), row);
      return empty;
    }

    if (upper.startsWith('SELECT * FROM TASKS WHERE TASKID = ?')) {
      const row = this.taskRows.get(String(params[0]));
      const rows = row ? [row] : [];
      return { toArray: () => rows, one: () => rows[0] || null, raw: () => rows[0] || null };
    }

    if (upper.startsWith('SELECT * FROM TASKS WHERE STATUS IN')) {
      const statuses = new Set(params.map(String));
      const rows = Array.from(this.taskRows.values()).filter(row => statuses.has(String(row.status)));
      return { toArray: () => rows, one: () => rows[0] || null, raw: () => rows[0] || null };
    }

    return empty;
  }
}

export async function runTaskDurablePersistenceTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const sql = new DurableTaskSqlMock();
    const storage = new CloudflareSqliteStorageAdapter(sql);
    const store = new TaskStore(undefined, 1, storage);

    const task = store.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'durable-ledger-restart' }
    });
    assert.strictEqual(store.startTask(task.taskId, 'kaggle-backend'), true);
    store.setExternalRun(task.taskId, {
      provider: 'kaggle',
      kernelRef: 'owner/durable-ledger-restart',
      submittedAt: Date.now(),
      reconciliationState: 'active'
    });

    await new Promise(resolve => setTimeout(resolve, 5));

    const persisted = await storage.getTask(task.taskId);
    assert.ok(persisted, 'Task must round-trip through Cloudflare SQLite storage');
    assert.strictEqual(persisted?.attempts?.length, 1, 'Durable attempt ledger must survive SQLite round-trip');
    assert.ok(persisted?.activeAttemptId, 'Active attempt ownership must survive SQLite round-trip');
    assert.strictEqual(persisted?.externalRun?.provider, 'kaggle', 'External run identity must survive SQLite round-trip');
    assert.strictEqual(persisted?.externalRun?.kernelRef, 'owner/durable-ledger-restart');

    const restoredStore = new TaskStore(undefined, 1, storage);
    restoredStore.hydrate([persisted!]);
    const recovery = restoredStore.recoverStaleTasks();
    assert.strictEqual(recovery.recoveredCount, 0, 'Externally-running Kaggle task must not be stale-requeued after restart');
    assert.strictEqual(restoredStore.getTask(task.taskId)?.status, 'running');

    assert.ok(sql.alters.some(sqlText => /ALTER TABLE tasks ADD COLUMN attemptsJson/i.test(sqlText)), 'Existing Durable Object DBs need an additive attemptsJson migration');
    assert.ok(sql.alters.some(sqlText => /ALTER TABLE tasks ADD COLUMN activeAttemptId/i.test(sqlText)), 'Existing Durable Object DBs need an additive activeAttemptId migration');
    assert.ok(sql.alters.some(sqlText => /ALTER TABLE tasks ADD COLUMN externalRunJson/i.test(sqlText)), 'Existing Durable Object DBs need an additive externalRunJson migration');
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Cloudflare durable task execution metadata survives restart\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
