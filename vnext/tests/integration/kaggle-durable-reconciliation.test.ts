import * as assert from 'assert';
// @ts-ignore
const { DatabaseSync } = require('node:sqlite');
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';
import { TaskStore } from '../../src/storage/task-store';
import { ArtifactStore } from '../../src/storage/artifact-store';
import { KaggleBackend, KagglePollScheduler } from '../../src/kaggle/backend';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { DurableTask, ExternalRunInfo } from '../../src/types/task';

export class RealSqliteShim implements SqlStorage {
  public db: any;

  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const trimmed = query.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('SELECT') || upper.startsWith('PRAGMA')) {
      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as any[];
      return {
        toArray: () => rows,
        one: () => rows[0] || null,
        raw: () => rows[0] || null
      };
    } else {
      if (query.includes(';') && params.length === 0) {
        this.db.exec(query);
      } else {
        const stmt = this.db.prepare(query);
        stmt.run(...params);
      }
      return {
        toArray: () => [],
        one: () => null,
        raw: () => null
      };
    }
  }
}

export async function runKaggleDurableReconciliationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  // Test 1: persists_external_run_across_sqlite_round_trip
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);

    const externalRun: ExternalRunInfo = {
      provider: 'kaggle',
      kernelRef: 'astorhsu/devspace-smoke-test',
      versionNumber: 1,
      submittedAt: Date.now() - 10000,
      lastPolledAt: Date.now() - 2000,
      lastRemoteStatus: 'queued',
      reconciliationState: 'active',
      metadata: { machineShape: 'cpu', tags: ['smoke', 'vnext'] }
    };

    const task: DurableTask = {
      taskId: 'task-external-run-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: 'devspace-smoke-test', code: 'print("hello")' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted to Kaggle'],
      externalRun,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000
    };

    await storage.saveTask(task);
    const reloaded = await storage.getTask(task.taskId);

    assert.ok(reloaded, 'Task should be retrieved from SQLite');
    assert.ok(reloaded.externalRun, 'externalRun must NOT be undefined after SQLite hydration');
    assert.deepStrictEqual(reloaded.externalRun, externalRun, 'externalRun must match exactly across SQLite round-trip');
    passed++;
    console.log('  [PASS] persists_external_run_across_sqlite_round_trip');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] persists_external_run_across_sqlite_round_trip: ${err.message}`);
  }

  // Test 2: stale_recovery_must_preserve_kaggle_remote_tasks
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);

    const now = Date.now();
    const externalRun: ExternalRunInfo = {
      provider: 'kaggle',
      kernelRef: 'astorhsu/devspace-smoke-test',
      versionNumber: 1,
      submittedAt: now - 120000,
      lastPolledAt: now - 30000,
      lastRemoteStatus: 'running',
      reconciliationState: 'active'
    };

    const task: DurableTask = {
      taskId: 'task-stale-kaggle-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: 'devspace-smoke-test', code: 'print("hello")' },
      lease: {
        claimedBy: 'kaggle-backend',
        claimedAt: now - 120000,
        lastHeartbeatAt: now - 120000,
        leaseExpiresAt: now - 60000 // Expired lease
      },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted to Kaggle'],
      externalRun,
      createdAt: now - 120000,
      updatedAt: now - 120000
    };

    await storage.saveTask(task);

    // Simulate cold-start DO hydration
    const taskStore = new TaskStore(undefined, 60000, storage);
    taskStore.hydrate(await storage.listTasks());

    // Run stale task recovery
    taskStore.recoverStaleTasks();

    const hydrated = taskStore.getTask('task-stale-kaggle-01');
    assert.ok(hydrated, 'Hydrated task must exist');
    assert.notStrictEqual(hydrated.status, 'queued', 'Kaggle remote task must NOT be reset to queued on local worker lease timeout');
    assert.strictEqual(hydrated.status, 'running', 'Kaggle task status should remain running');
    assert.ok(!hydrated.logs.some(l => l.includes('[STALE_DETECTION]')), 'Kaggle task must not log false-positive STALE_DETECTION');
    passed++;
    console.log('  [PASS] stale_recovery_must_preserve_kaggle_remote_tasks');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] stale_recovery_must_preserve_kaggle_remote_tasks: ${err.message}`);
  }

  // Test 3: dangling_reconciliation_survives_cold_start
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);

    const now = Date.now();
    const externalRun: ExternalRunInfo = {
      provider: 'kaggle',
      kernelRef: 'astorhsu/devspace-smoke-test',
      versionNumber: 1,
      submittedAt: now - 60000,
      lastPolledAt: now - 15000,
      lastRemoteStatus: 'queued',
      reconciliationState: 'active'
    };

    const task: DurableTask = {
      taskId: 'task-dangling-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: 'devspace-smoke-test', code: 'print("hello")' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted'],
      externalRun,
      createdAt: now - 60000,
      updatedAt: now - 60000
    };

    await storage.saveTask(task);

    // Simulate DO restart and hydration
    const taskStore = new TaskStore(undefined, 60000, storage);
    taskStore.hydrate(await storage.listTasks());
    const artifactStore = new ArtifactStore(undefined, 50 * 1024 * 1024, storage);

    // Mock client where Kaggle execution is complete
    const mockClient: any = {
      getUsername: () => 'astorhsu',
      getKernelStatus: async (_slug: string) => ({ status: 'complete', rawMessage: 'complete' }),
      downloadKernelOutput: async (_slug: string) => ({
        success: true,
        files: [{ name: 'stdout.log', content: 'DEVSPACE_VNEXT_KAGGLE_RECONCILIATION_PASS\n' }],
        log: 'DEVSPACE_VNEXT_KAGGLE_RECONCILIATION_PASS\n'
      })
    };

    const kaggleBackend = new KaggleBackend(taskStore, artifactStore, mockClient);
    const { reconciledCount } = await kaggleBackend.reconcileDanglingTasks();

    assert.strictEqual(reconciledCount, 1, 'Should reconcile exactly 1 dangling Kaggle task');
    const reconciledTask = taskStore.getTask('task-dangling-01');
    assert.strictEqual(reconciledTask?.status, 'succeeded', 'Task should transition to succeeded upon Kaggle completion');
    assert.ok(reconciledTask?.logs.some(l => l.includes('DEVSPACE_VNEXT_KAGGLE_RECONCILIATION_PASS')), 'Logs must include output from stdout.log');
    passed++;
    console.log('  [PASS] dangling_reconciliation_survives_cold_start');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] dangling_reconciliation_survives_cold_start: ${err.message}`);
  }

  // Test 4: kaggle_log_nullable_parsing
  try {
    const client = new CloudflareKaggleHttpClient({ username: 'astorhsu', key: 'mock-key' });

    // Mock global fetch to return logNullable response
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes('/kernels/output')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              logNullable: JSON.stringify([
                { stream_name: 'stdout', data: 'DEVSPACE_VNEXT_KAGGLE_RECONCILIATION_PASS\n' }
              ]),
              files: []
            })
          } as any;
        }
        return { ok: false, status: 404 } as any;
      }) as any;

      const out = await client.downloadKernelOutput('devspace-smoke-test');
      assert.strictEqual(out.success, true);
      assert.ok(out.files.some(f => f.name === 'stdout.log' && f.content?.includes('DEVSPACE_VNEXT_KAGGLE_RECONCILIATION_PASS')), 'Must parse logNullable into stdout.log artifact');
      assert.ok(out.log?.includes('DEVSPACE_VNEXT_KAGGLE_RECONCILIATION_PASS'), 'Must populate out.log from logNullable');
      passed++;
      console.log('  [PASS] kaggle_log_nullable_parsing (logNullable)');
    } finally {
      globalThis.fetch = origFetch;
    }

    // Also test standard data.log for compatibility
    try {
      globalThis.fetch = (async (url: string) => {
        if (url.includes('/kernels/output')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              log: JSON.stringify([
                { stream_name: 'stdout', data: 'DEVSPACE_VNEXT_LEGACY_LOG_PASS\n' }
              ]),
              files: []
            })
          } as any;
        }
        return { ok: false, status: 404 } as any;
      }) as any;

      const out = await client.downloadKernelOutput('devspace-smoke-test');
      assert.strictEqual(out.success, true);
      assert.ok(out.files.some(f => f.name === 'stdout.log' && f.content?.includes('DEVSPACE_VNEXT_LEGACY_LOG_PASS')), 'Must parse standard log into stdout.log artifact');
      passed++;
      console.log('  [PASS] kaggle_log_nullable_parsing (legacy data.log compatibility)');
    } finally {
      globalThis.fetch = origFetch;
    }
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] kaggle_log_nullable_parsing: ${err.message}`);
  }

  // Test 5: no_duplicate_kaggle_submit_after_restart
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);

    const now = Date.now();
    const externalRun: ExternalRunInfo = {
      provider: 'kaggle',
      kernelRef: 'astorhsu/devspace-smoke-test',
      versionNumber: 1,
      submittedAt: now - 30000,
      lastPolledAt: now - 5000,
      lastRemoteStatus: 'running',
      reconciliationState: 'active'
    };

    const task: DurableTask = {
      taskId: 'task-no-duplicate-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: 'devspace-smoke-test', code: 'print("hello")' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted'],
      externalRun,
      createdAt: now - 30000,
      updatedAt: now - 30000
    };

    await storage.saveTask(task);

    const taskStore = new TaskStore(undefined, 60000, storage);
    taskStore.hydrate(await storage.listTasks());
    const artifactStore = new ArtifactStore(undefined, 50 * 1024 * 1024, storage);

    let pushKernelCalls = 0;
    let getKernelStatusCalls = 0;

    const mockClient: any = {
      getUsername: () => 'astorhsu',
      pushKernel: async () => {
        pushKernelCalls++;
        return { success: true, kernelSlug: 'astorhsu/devspace-smoke-test' };
      },
      getKernelStatus: async (_slug: string) => {
        getKernelStatusCalls++;
        return { status: 'running', rawMessage: 'still running' };
      }
    };

    const kaggleBackend = new KaggleBackend(taskStore, artifactStore, mockClient);
    await kaggleBackend.reconcileDanglingTasks();

    assert.strictEqual(pushKernelCalls, 0, 'Must NEVER call pushKernel during restart reconciliation');
    assert.strictEqual(getKernelStatusCalls, 1, 'Should call getKernelStatus to check remote state');
    passed++;
    console.log('  [PASS] no_duplicate_kaggle_submit_after_restart');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] no_duplicate_kaggle_submit_after_restart: ${err.message}`);
  }

  // Test 6: concurrent_reconcile_finalizes_once
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);
    const now = Date.now();

    const externalRun: ExternalRunInfo = {
      provider: 'kaggle',
      kernelRef: 'astorhsu/concurrent-test',
      versionNumber: 1,
      submittedAt: now - 30000,
      lastPolledAt: now - 5000,
      lastRemoteStatus: 'running',
      reconciliationState: 'active'
    };

    const task: DurableTask = {
      taskId: 'task-concurrent-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: 'concurrent-test', code: 'print("hello")' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted'],
      externalRun,
      createdAt: now - 30000,
      updatedAt: now - 30000
    };

    await storage.saveTask(task);
    const taskStore = new TaskStore(undefined, 60000, storage);
    taskStore.hydrate(await storage.listTasks());
    const artifactStore = new ArtifactStore(undefined, 50 * 1024 * 1024, storage);

    let getKernelStatusCalls = 0;
    let downloadKernelOutputCalls = 0;

    const mockClient: any = {
      getUsername: () => 'astorhsu',
      getKernelStatus: async (_slug: string) => {
        getKernelStatusCalls++;
        await new Promise(r => setTimeout(r, 20));
        return { status: 'complete', rawMessage: 'done' };
      },
      downloadKernelOutput: async (_slug: string, _dir: string) => {
        downloadKernelOutputCalls++;
        await new Promise(r => setTimeout(r, 20));
        return {
          success: true,
          files: [{ name: 'stdout.log', content: 'concurrent output test' }]
        };
      }
    };

    const kaggleBackend = new KaggleBackend(taskStore, artifactStore, mockClient);

    await Promise.all([
      kaggleBackend.reconcileTask('task-concurrent-01'),
      kaggleBackend.reconcileTask('task-concurrent-01'),
      kaggleBackend.reconcileTask('task-concurrent-01')
    ]);

    assert.strictEqual(getKernelStatusCalls, 1, 'getKernelStatus must be called exactly once');
    assert.strictEqual(downloadKernelOutputCalls, 1, 'downloadKernelOutput must be called exactly once');

    const finalizedTask = taskStore.getTask('task-concurrent-01');
    assert.strictEqual(finalizedTask?.status, 'succeeded', 'Task should succeed');
    assert.strictEqual(finalizedTask?.artifacts.length, 1, 'Artifacts must only be ingested once');
    assert.strictEqual(finalizedTask?.artifacts[0].name, 'stdout.log');

    const finalizeLogs = finalizedTask?.logs.filter(l => l.includes('Kaggle kernel run finalized successfully')) || [];
    assert.strictEqual(finalizeLogs.length, 1, 'Finalize log must appear exactly once');

    passed++;
    console.log('  [PASS] concurrent_reconcile_finalizes_once');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] concurrent_reconcile_finalizes_once: ${err.message}`);
  }

  // Test 7: cancel_during_reconcile_does_not_finalize
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);
    const now = Date.now();

    const externalRun: ExternalRunInfo = {
      provider: 'kaggle',
      kernelRef: 'astorhsu/cancel-test',
      versionNumber: 1,
      submittedAt: now - 30000,
      lastPolledAt: now - 5000,
      lastRemoteStatus: 'running',
      reconciliationState: 'active'
    };

    const task: DurableTask = {
      taskId: 'task-cancel-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: 'cancel-test', code: 'print("hello")' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted'],
      externalRun,
      createdAt: now - 30000,
      updatedAt: now - 30000
    };

    await storage.saveTask(task);
    const taskStore = new TaskStore(undefined, 60000, storage);
    taskStore.hydrate(await storage.listTasks());
    const artifactStore = new ArtifactStore(undefined, 50 * 1024 * 1024, storage);

    let resolveStatusPromise: any;
    const statusPromise = new Promise(resolve => {
      resolveStatusPromise = resolve;
    });

    let downloadKernelOutputCalls = 0;

    const mockClient: any = {
      getUsername: () => 'astorhsu',
      getKernelStatus: async (_slug: string) => {
        await statusPromise;
        return { status: 'complete', rawMessage: 'done' };
      },
      downloadKernelOutput: async (_slug: string, _dir: string) => {
        downloadKernelOutputCalls++;
        return { success: true, files: [{ name: 'stdout.log', content: 'should not be saved' }] };
      }
    };

    const kaggleBackend = new KaggleBackend(taskStore, artifactStore, mockClient);

    const reconcilePromise = kaggleBackend.reconcileTask('task-cancel-01');

    taskStore.cancelTask('task-cancel-01', 'Cancelled by user during run');
    assert.strictEqual(taskStore.getTask('task-cancel-01')?.status, 'cancelled');

    resolveStatusPromise();
    await reconcilePromise;

    const taskAfter = taskStore.getTask('task-cancel-01');
    assert.strictEqual(taskAfter?.status, 'cancelled', 'Task MUST remain cancelled');
    assert.strictEqual(downloadKernelOutputCalls, 0, 'downloadKernelOutput must not be called');
    assert.strictEqual(taskAfter?.artifacts.length, 0, 'Must not ingest artifacts on cancelled task');

    passed++;
    console.log('  [PASS] cancel_during_reconcile_does_not_finalize');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] cancel_during_reconcile_does_not_finalize: ${err.message}`);
  }

  // Test 8: concurrent_reconcile_preserves_reschedule_intent
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);
    const now = Date.now();

    const makeTask = (id: string, slug: string): DurableTask => ({
      taskId: id,
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 5,
      payload: { kernelSlug: slug, code: 'print("poll")' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
      artifacts: [],
      logs: ['Submitted'],
      externalRun: {
        provider: 'kaggle',
        kernelRef: `astorhsu/${slug}`,
        versionNumber: 1,
        submittedAt: now - 10000,
        lastPolledAt: now - 5000,
        lastRemoteStatus: 'running',
        reconciliationState: 'active'
      },
      createdAt: now - 10000,
      updatedAt: now - 5000
    });

    const taskStore = new TaskStore(undefined, 60000, storage);
    const artifactStore = new ArtifactStore(undefined, 50 * 1024 * 1024, storage);

    let getKernelStatusCalls = 0;
    let scheduleCalls = 0;
    let delayMs = 30;
    let remoteStatus = 'running';

    const mockClient: any = {
      getUsername: () => 'astorhsu',
      getKernelStatus: async (_slug: string) => {
        getKernelStatusCalls++;
        if (delayMs > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
        return { status: remoteStatus, rawMessage: 'status' };
      },
      downloadKernelOutput: async () => ({ success: true, files: [] })
    };

    const mockScheduler: KagglePollScheduler = {
      schedule: async (_taskId: string, _kernelSlug: string, _delay: number) => {
        scheduleCalls++;
      }
    };

    const kaggleBackend = new KaggleBackend(
      taskStore,
      artifactStore,
      mockClient,
      undefined,
      15000,
      mockScheduler
    );

    // Subtest A: false + true concurrent (preserves true intent)
    const taskA = makeTask('task-resched-ft', 'resched-ft');
    await storage.saveTask(taskA);
    taskStore.hydrate([taskA]);
    getKernelStatusCalls = 0;
    scheduleCalls = 0;
    remoteStatus = 'running';

    const p1 = kaggleBackend.reconcileTask('task-resched-ft', false);
    const p2 = kaggleBackend.reconcileTask('task-resched-ft', true);
    const [res1, res2] = await Promise.all([p1, p2]);

    assert.strictEqual(res1, true, 'Task should still be active');
    assert.strictEqual(res2, true, 'Task should still be active');
    assert.strictEqual(getKernelStatusCalls, 1, 'getKernelStatus must be called exactly once');
    assert.strictEqual(scheduleCalls, 1, 'schedulePoll must be called exactly once (intent preserved)');

    // Subtest B: true + true concurrent (no duplicate schedule)
    const taskB = makeTask('task-resched-tt', 'resched-tt');
    await storage.saveTask(taskB);
    taskStore.hydrate([taskB]);
    getKernelStatusCalls = 0;
    scheduleCalls = 0;
    remoteStatus = 'running';

    const pB1 = kaggleBackend.reconcileTask('task-resched-tt', true);
    const pB2 = kaggleBackend.reconcileTask('task-resched-tt', true);
    await Promise.all([pB1, pB2]);

    assert.strictEqual(getKernelStatusCalls, 1, 'getKernelStatus must be called exactly once');
    assert.strictEqual(scheduleCalls, 1, 'schedulePoll must be called exactly once for true+true');

    // Subtest C: terminal during reconciliation (does not schedule)
    const taskC = makeTask('task-resched-term', 'resched-term');
    await storage.saveTask(taskC);
    taskStore.hydrate([taskC]);
    getKernelStatusCalls = 0;
    scheduleCalls = 0;
    remoteStatus = 'complete';

    const pC1 = kaggleBackend.reconcileTask('task-resched-term', false);
    const pC2 = kaggleBackend.reconcileTask('task-resched-term', true);
    await Promise.all([pC1, pC2]);

    assert.strictEqual(scheduleCalls, 0, 'Must NOT schedule poll for terminal (complete) task');

    // Subtest D: cancelled during reconciliation (does not schedule)
    const taskD = makeTask('task-resched-cancel', 'resched-cancel');
    await storage.saveTask(taskD);
    taskStore.hydrate([taskD]);
    getKernelStatusCalls = 0;
    scheduleCalls = 0;
    remoteStatus = 'running';

    const pD1 = kaggleBackend.reconcileTask('task-resched-cancel', false);
    const pD2 = kaggleBackend.reconcileTask('task-resched-cancel', true);
    taskStore.cancelTask('task-resched-cancel', 'Cancelled during poll');
    await Promise.all([pD1, pD2]);

    assert.strictEqual(scheduleCalls, 0, 'Must NOT schedule poll for cancelled task');

    passed++;
    console.log('  [PASS] concurrent_reconcile_preserves_reschedule_intent');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] concurrent_reconcile_preserves_reschedule_intent: ${err.message}`);
  }

  // Test 9: old_schema_without_externalRunJson_migrates
  try {
    const shim = new RealSqliteShim();
    shim.db.exec(`
      CREATE TABLE tasks (
        taskId TEXT PRIMARY KEY,
        taskKey TEXT,
        idempotencyKey TEXT,
        clientRequestId TEXT,
        backend TEXT NOT NULL,
        capability TEXT NOT NULL,
        requiredScope TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        payloadJson TEXT,
        retryPolicyJson TEXT,
        leaseJson TEXT,
        resultJson TEXT,
        errorJson TEXT,
        artifactsJson TEXT,
        logsJson TEXT,
        metadataJson TEXT,
        startedAt INTEGER,
        completedAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        attemptsJson TEXT,
        activeAttemptId TEXT
      );
    `);

    shim.db.prepare(`
      INSERT INTO tasks (
        taskId, backend, capability, requiredScope, status, priority,
        payloadJson, retryPolicyJson, artifactsJson, logsJson, metadataJson,
        createdAt, updatedAt, attemptsJson, activeAttemptId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'task-legacy-01',
      'kaggle',
      'kaggle:run',
      'kaggle:submit',
      'running',
      0,
      JSON.stringify({ kernelSlug: 'legacy-kernel' }),
      JSON.stringify({ maxRetries: 0, retryCount: 0, backoffMs: 0, requeueOnStale: false }),
      '[]',
      '["Legacy log line"]',
      JSON.stringify({ persistentKey: 'persistedValue' }),
      Date.now() - 50000,
      Date.now() - 50000,
      JSON.stringify([{ id: 'att-legacy-1', attemptNumber: 1, status: 'running', claimedBy: 'worker-1', claimedAt: Date.now() - 50000 }]),
      'att-legacy-1'
    );

    const preCols = (shim.db.prepare('PRAGMA table_info(tasks)').all() as any[]).map((c: any) => c.name);
    assert.strictEqual(preCols.includes('externalRunJson'), false, 'Initial schema must not have externalRunJson');
    assert.strictEqual(preCols.includes('attemptsJson'), true, 'Initial schema must have attemptsJson');

    const storage = new CloudflareSqliteStorageAdapter(shim);

    const postCols = (shim.db.prepare('PRAGMA table_info(tasks)').all() as any[]).map((c: any) => c.name);
    assert.strictEqual(postCols.includes('externalRunJson'), true, 'Migrated schema MUST have externalRunJson');
    assert.strictEqual(postCols.includes('attemptsJson'), true, 'attemptsJson must still exist');
    assert.strictEqual(postCols.includes('activeAttemptId'), true, 'activeAttemptId must still exist');
    assert.strictEqual(postCols.includes('metadataJson'), true, 'metadataJson must still exist');

    const reloaded = await storage.getTask('task-legacy-01');
    assert.ok(reloaded, 'Legacy task must load cleanly');
    assert.strictEqual(reloaded.externalRun, undefined, 'externalRun should be undefined for legacy task');
    assert.strictEqual(reloaded.activeAttemptId, 'att-legacy-1', 'activeAttemptId preserved');
    assert.strictEqual(reloaded.attempts?.[0]?.id, 'att-legacy-1', 'attempts ledger preserved');
    assert.strictEqual(reloaded.metadata?.persistentKey, 'persistedValue', 'metadata preserved');

    passed++;
    console.log('  [PASS] old_schema_without_externalRunJson_migrates');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] old_schema_without_externalRunJson_migrates: ${err.message}`);
  }

  // Test 10: malformed_externalRunJson_does_not_break_task_load
  try {
    const shim = new RealSqliteShim();
    const storage = new CloudflareSqliteStorageAdapter(shim);

    const task: DurableTask = {
      taskId: 'task-malformed-01',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 0,
      payload: { kernelSlug: 'malformed-test' },
      retryPolicy: { maxRetries: 0, retryCount: 0, backoffMs: 0, requeueOnStale: false },
      artifacts: [],
      logs: ['Test log'],
      metadata: { key: 'val' },
      attempts: [{ id: 'att-m-1', attemptNumber: 1, status: 'running', claimedBy: 'worker-1', claimedAt: Date.now() }],
      activeAttemptId: 'att-m-1',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await storage.saveTask(task);

    shim.db.prepare("UPDATE tasks SET externalRunJson = '{broken-json' WHERE taskId = 'task-malformed-01'").run();

    const reloaded = await storage.getTask('task-malformed-01');
    assert.ok(reloaded, 'Task with corrupted externalRunJson must load without throwing');
    assert.strictEqual(reloaded.externalRun, undefined, 'externalRun must fall back to undefined');
    assert.strictEqual(reloaded.activeAttemptId, 'att-m-1', 'activeAttemptId must remain intact');
    assert.strictEqual(reloaded.attempts?.[0]?.id, 'att-m-1', 'attempts ledger must remain intact');
    assert.strictEqual(reloaded.metadata?.key, 'val', 'metadata must remain intact');

    passed++;
    console.log('  [PASS] malformed_externalRunJson_does_not_break_task_load');
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] malformed_externalRunJson_does_not_break_task_load: ${err.message}`);
  }

  // Test 11: logNullable_test_matrix
  try {
    const client = new CloudflareKaggleHttpClient({ username: 'astorhsu', key: 'mock-key' });
    const origFetch = globalThis.fetch;

    const cases = [
      {
        name: 'LOG_NULL',
        response: { logNullable: null, files: [] },
        expectedLog: undefined,
        expectStdoutLog: false
      },
      {
        name: 'LOG_UNDEFINED',
        response: { files: [] },
        expectedLog: undefined,
        expectStdoutLog: false
      },
      {
        name: 'LOG_PLAIN_STRING',
        response: { logNullable: 'plain string output\n', files: [] },
        expectedLog: 'plain string output\n',
        expectStdoutLog: true,
        expectedContent: 'plain string output\n'
      },
      {
        name: 'LOG_DIRECT_ARRAY',
        response: {
          logNullable: [{ stream_name: 'stdout', data: 'hello' }],
          files: []
        },
        expectedLog: 'hello',
        expectStdoutLog: true,
        expectedContent: 'hello'
      },
      {
        name: 'LEGACY_LOG_STRING',
        response: { log: 'plain legacy string\n', files: [] },
        expectedLog: 'plain legacy string\n',
        expectStdoutLog: true,
        expectedContent: 'plain legacy string\n'
      },
      {
        name: 'LEGACY_LOG_ARRAY',
        response: {
          log: [{ stream_name: 'stdout', data: 'hello legacy' }],
          files: []
        },
        expectedLog: 'hello legacy',
        expectStdoutLog: true,
        expectedContent: 'hello legacy'
      },
      {
        name: 'MULTI_ELEMENT_LOG_NULLABLE',
        response: {
          logNullable: [
            { stream_name: 'stdout', data: 'part A\n' },
            { stream_name: 'stdout', data: 'part B\n' }
          ],
          files: []
        },
        expectedLog: 'part A\npart B\n',
        expectStdoutLog: true,
        expectedContent: 'part A\npart B\n'
      },
      {
        name: 'MULTI_ELEMENT_LEGACY_LOG',
        response: {
          log: [
            { stream_name: 'stdout', data: 'part A\n' },
            { stream_name: 'stdout', data: 'part B\n' }
          ],
          files: []
        },
        expectedLog: 'part A\npart B\n',
        expectStdoutLog: true,
        expectedContent: 'part A\npart B\n'
      }
    ];

    try {
      for (const tc of cases) {
        globalThis.fetch = (async (url: string) => {
          if (url.includes('/kernels/output')) {
            return {
              ok: true,
              status: 200,
              json: async () => tc.response
            } as any;
          }
          return { ok: false, status: 404 } as any;
        }) as any;

        const out = await client.downloadKernelOutput('test-slug');
        assert.strictEqual(out.success, true, `[${tc.name}] Must succeed`);

        if (tc.expectedLog !== undefined) {
          assert.strictEqual(out.log, tc.expectedLog, `[${tc.name}] out.log mismatch`);
        } else {
          assert.strictEqual(out.log, undefined, `[${tc.name}] out.log must be undefined`);
        }

        assert.ok(out.log !== 'undefined', `[${tc.name}] out.log must not be literal 'undefined'`);
        assert.ok(out.log !== '[object Object]', `[${tc.name}] out.log must not be '[object Object]'`);

        const stdoutFile = out.files.find(f => f.name === 'stdout.log');
        if (tc.expectStdoutLog) {
          assert.ok(stdoutFile, `[${tc.name}] stdout.log file must be present`);
          assert.strictEqual(stdoutFile.content, tc.expectedContent, `[${tc.name}] stdout.log content mismatch`);
          assert.ok(stdoutFile.content !== 'undefined', `[${tc.name}] file content must not be 'undefined'`);
          assert.ok(stdoutFile.content !== '[object Object]', `[${tc.name}] file content must not be '[object Object]'`);
        } else {
          assert.strictEqual(stdoutFile, undefined, `[${tc.name}] stdout.log should not be generated`);
        }

        console.log(`  [PASS] logNullable_matrix: ${tc.name}`);
      }
      passed++;
      console.log('  [PASS] logNullable_test_matrix (all 8 cases passed)');
    } finally {
      globalThis.fetch = origFetch;
    }
  } catch (err: any) {
    failed++;
    console.log(`  [FAIL] logNullable_test_matrix: ${err.message}`);
  }

  return { passed, failed };
}

if (require.main === module) {
  runKaggleDurableReconciliationTests().then(res => {
    console.log(`\nResults: ${res.passed} passed, ${res.failed} failed`);
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
