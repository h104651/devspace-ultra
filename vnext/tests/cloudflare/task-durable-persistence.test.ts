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

    if (upper.startsWith('SELECT TASKID, BACKEND, CAPABILITY, STATUS, TARGETDEVICEID, LEASEJSON, ATTEMPTSJSON')) {
      assert.ok(!/payloadJson|resultJson|logsJson|errorJson|metadataJson/i.test(query));
      const active = new Set(['queued','claimed','acknowledged','running','retrying']);
      const rows = Array.from(this.taskRows.values()).filter(row =>
        active.has(row.status) || (row.backend === 'local' && row.status === 'stale'))
        .sort((a,b) => String(a.taskId).localeCompare(String(b.taskId))).slice(0, Number(params[0]));
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

    const local = store.createTask({ backend: 'local', capability: 'local:write_file', targetDeviceId: 'fixture-device', payload: { content: 'do-not-expose' } });
    assert.ok(store.claimTaskById(local.taskId, 'fixture-device', 1000, 'old-session'));
    assert.strictEqual(store.failTasksForSupersededSession('fixture-device', 'old-session'), 1);
    const cold = new TaskStore(undefined, 1, storage);
    cold.hydrate(await storage.listActiveTasks());
    assert.strictEqual(cold.listTasks().some(t => t.taskId === local.taskId), false, 'Cold-start working set excludes stale history');
    const inventory = cold.taskInventory({});
    assert.strictEqual(inventory.summary.allActiveCount, 1);
    assert.strictEqual(inventory.summary.staleLocalCount, 1);
    assert.ok(inventory.tasks.some(t => t.taskId === local.taskId && t.status === 'stale'));
    assert.ok(!JSON.stringify(inventory).includes('do-not-expose'));
    assert.strictEqual(inventory.maintenanceAuthorized, false);
    passed++;

    // A pending cancellation survives DO working-set rehydration but never
    // transfers to a new attempt/session or overwrites stale.
    const execution = store.createTask({ backend: 'local', capability: 'local:build_project', targetDeviceId: 'cancel-fixture', payload: {}, metadata: { executionAdmission: { sessionId: 'cancel-session', policyRevision: 'a'.repeat(32) }, executionCancellation: { requestId: 'caller-forged' } } });
    assert.strictEqual(execution.metadata?.executionCancellation, undefined);
    assert.ok(store.claimTaskById(execution.taskId, 'cancel-fixture', 60000, 'cancel-session', 'a'.repeat(32)));
    const attempt = execution.activeAttemptId!;
    const requestId = store.requestExecutionCancellation(execution.taskId, 'cancel-fixture', 'cancel-session', attempt);
    const restarted = new TaskStore(undefined, 60000, storage);
    restarted.hydrate(await storage.listActiveTasks());
    assert.strictEqual(restarted.getPendingExecutionCancellation(execution.taskId, 'cancel-fixture', 'cancel-session', attempt)?.requestId, requestId);
    assert.strictEqual(restarted.confirmExecutionCancellation(execution.taskId, 'cancel-fixture', 'new-session', attempt, requestId), false);
    assert.strictEqual(restarted.failTasksForSupersededSession('cancel-fixture', 'cancel-session'), 1);
    assert.strictEqual(restarted.confirmExecutionCancellation(execution.taskId, 'cancel-fixture', 'cancel-session', attempt, requestId), false);
    assert.strictEqual((await storage.getTask(execution.taskId))?.status, 'stale');
    passed++;

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
