import * as assert from 'assert';
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';

const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => any };

function cursor(rows: any[] = []) {
  return {
    toArray: () => rows,
    one: () => rows[0] || null,
    raw: () => rows
  };
}

class RealNodeSqlStorage implements SqlStorage {
  public db = new DatabaseSync(':memory:');

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const trimmed = query.trim();
    const isQuery = /^(SELECT|PRAGMA|WITH)\b/i.test(trimmed);

    if (params.length === 0 && !isQuery) {
      this.db.exec(query);
      return cursor();
    }

    const statement = this.db.prepare(query);
    if (isQuery) return cursor(statement.all(...params));
    statement.run(...params);
    return cursor();
  }
}

const PRE_RELIABILITY_TASKS_SCHEMA = `
  CREATE TABLE tasks (
    taskId TEXT PRIMARY KEY, taskKey TEXT, idempotencyKey TEXT, clientRequestId TEXT,
    backend TEXT NOT NULL, capability TEXT NOT NULL, requiredScope TEXT NOT NULL,
    status TEXT NOT NULL, priority INTEGER NOT NULL, payloadJson TEXT NOT NULL,
    retryPolicyJson TEXT NOT NULL, leaseJson TEXT, resultJson TEXT, errorJson TEXT,
    artifactsJson TEXT NOT NULL, logsJson TEXT NOT NULL, metadataJson TEXT,
    startedAt INTEGER, completedAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  );
`;

export async function runSqliteSchemaMigrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const sql = new RealNodeSqlStorage();
    sql.db.exec(PRE_RELIABILITY_TASKS_SCHEMA);
    sql.db.prepare(`
      INSERT INTO tasks (
        taskId, backend, capability, requiredScope, status, priority, payloadJson,
        retryPolicyJson, artifactsJson, logsJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-active-task', 'kaggle', 'kaggle:run', 'kaggle:submit', 'running', 0,
      JSON.stringify({ kernelSlug: 'owner/legacy-active-task' }),
      JSON.stringify({ maxRetries: 3, retryCount: 0, backoffMs: 1000, requeueOnStale: true }),
      '[]', '[]', Date.now() - 1000, Date.now() - 500
    );

    const storage = new CloudflareSqliteStorageAdapter(sql);
    const columns = sql.db.prepare('PRAGMA table_info(tasks)').all().map((row: any) => row.name);
    assert.ok(columns.includes('attemptsJson'), 'Migration must add attemptsJson to a pre-existing tasks table');
    assert.ok(columns.includes('activeAttemptId'), 'Migration must add activeAttemptId to a pre-existing tasks table');
    assert.ok(columns.includes('externalRunJson'), 'Migration must add externalRunJson to a pre-existing tasks table');

    const legacy = await storage.getTask('legacy-active-task');
    assert.ok(legacy, 'Legacy task must remain readable after migration');
    assert.deepStrictEqual(legacy?.attempts, [], 'Legacy rows must receive an empty attempt ledger default');

    legacy!.attempts = [{
      id: 'attempt-1-migrated',
      attemptNumber: 1,
      status: 'running',
      claimedBy: 'kaggle-backend',
      claimedAt: Date.now() - 1000,
      startedAt: Date.now() - 900
    } as any];
    legacy!.activeAttemptId = 'attempt-1-migrated';
    legacy!.externalRun = {
      provider: 'kaggle',
      kernelRef: 'owner/legacy-active-task',
      submittedAt: Date.now() - 1000,
      reconciliationState: 'active'
    } as any;
    await storage.saveTask(legacy!);

    const roundTrip = await storage.getTask('legacy-active-task');
    assert.strictEqual(roundTrip?.attempts?.length, 1, 'Migrated rows must persist new attempt metadata');
    assert.strictEqual(roundTrip?.activeAttemptId, 'attempt-1-migrated');
    assert.strictEqual(roundTrip?.externalRun?.kernelRef, 'owner/legacy-active-task');
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Real SQLite pre-reliability tasks schema migrates cleanly\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
