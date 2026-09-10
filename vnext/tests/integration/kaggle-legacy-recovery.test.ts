import * as assert from 'assert';
import { KaggleBackend } from '../../src/kaggle/backend';
import { IKaggleClient } from '../../src/kaggle/kaggle-client.interface';
import { ArtifactStore } from '../../src/storage/artifact-store';
import { TaskStore } from '../../src/storage/task-store';

class LegacyRunningKaggleClient implements IKaggleClient {
  public statusCalls: string[] = [];
  hasCredentials(): boolean { return true; }
  getUsername(): string { return 'legacy-test'; }
  async pushKernel(): Promise<any> { throw new Error('pushKernel must not be called during restart reconciliation'); }
  async getKernelStatus(kernelSlug: string): Promise<any> {
    this.statusCalls.push(kernelSlug);
    return { status: 'running', rawMessage: 'still running remotely' };
  }
  async downloadKernelOutput(): Promise<any> { return { success: true, files: [] }; }
}

export async function runKaggleLegacyRecoveryTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const now = Date.now();
    const store = new TaskStore(undefined, 1);
    store.hydrate([{
      taskId: 'legacy-kaggle-running',
      backend: 'kaggle',
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'running',
      priority: 0,
      payload: { kernelSlug: 'owner/legacy-running' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 1000, requeueOnStale: true },
      lease: {
        claimedBy: 'kaggle-backend',
        claimedAt: now - 120000,
        leaseExpiresAt: now - 60000,
        lastHeartbeatAt: now - 120000
      },
      attempts: [],
      artifacts: [],
      logs: [],
      startedAt: now - 120000,
      createdAt: now - 130000,
      updatedAt: now - 60000
    } as any]);

    const staleRecovery = store.recoverStaleTasks();
    assert.strictEqual(staleRecovery.recoveredCount, 0, 'Kaggle backend tasks must never be requeued by local lease expiry');
    assert.strictEqual(store.getTask('legacy-kaggle-running')?.status, 'running');

    const client = new LegacyRunningKaggleClient();
    let scheduled = 0;
    const backend = new KaggleBackend(
      store,
      new ArtifactStore(),
      client,
      undefined,
      50,
      { schedule: async () => { scheduled++; } }
    );

    const reconciled = await backend.reconcileDanglingTasks();
    assert.strictEqual(reconciled.reconciledCount, 1, 'Legacy Kaggle task without externalRun must still be rediscovered by backend/payload identity');
    assert.deepStrictEqual(client.statusCalls, ['owner/legacy-running']);
    const after = store.getTask('legacy-kaggle-running');
    assert.strictEqual(after?.status, 'running');
    assert.strictEqual(after?.externalRun?.provider, 'kaggle', 'Reconciliation must backfill durable externalRun metadata');
    assert.strictEqual(after?.externalRun?.kernelRef, 'owner/legacy-running');
    assert.ok(scheduled >= 1, 'Still-running legacy Kaggle task must resume durable polling');
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Pre-migration Kaggle task survives restart without duplicate requeue\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
