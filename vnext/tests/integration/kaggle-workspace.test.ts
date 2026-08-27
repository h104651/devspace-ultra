import * as assert from 'assert';
import * as crypto from 'crypto';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { TaskStore } from '../../src/storage/task-store';
import { ArtifactStore } from '../../src/storage/artifact-store';
import { IdempotencyStore } from '../../src/storage/idempotency-store';
import { KaggleBackend } from '../../src/kaggle/backend';
import { TaskRouter } from '../../src/gateway/task-router';
import { McpHandlers } from '../../src/mcp/handlers';
import { KillSwitch } from '../../src/security/kill-switch';
import { computeWorkspaceFingerprint, DevSpaceProjectManifest } from '../../src/kaggle/workspace-manager';

export async function runKaggleWorkspaceTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const runTest = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      console.error(`\n  FAIL: ${name}\n  ${err.stack || err.message}`);
      failed++;
    }
  };

  const client = new CloudflareKaggleHttpClient({ username: 'testuser', key: 'testkey', isMockMode: true });
  const taskStore = new TaskStore();
  const artifactStore = new ArtifactStore();
  const idempotencyStore = new IdempotencyStore();
  const kaggleBackend = new KaggleBackend(taskStore, artifactStore, client);
  const killSwitch = new KillSwitch();
  const auditLogger: any = { log: () => {} };
  const taskRouter = new TaskRouter(
    taskStore,
    idempotencyStore,
    kaggleBackend,
    { dispatchTask: () => ({ taskId: 's1' }), listWorkers: () => [] } as any,
    killSwitch,
    auditLogger
  );

  const mockR2Storage: any = {
    putArtifact: async (art: any, buf: Buffer) => {
      return { key: art.id, size: buf.length };
    }
  };

  const gatewayFacade: any = {
    taskRouter,
    taskStore,
    artifactStore,
    kaggleBackend,
    r2Storage: mockR2Storage,
    authManager: { listDevices: () => [] },
    connectionManager: { getConnectedAgents: () => [] },
    killSwitch
  };

  const handlers = new McpHandlers(gatewayFacade);

  const adminCaller = {
    scopes: ['admin', 'kaggle:read', 'kaggle:submit', 'tasks:read', 'tasks:submit', 'local:read'],
    subjectId: 'user-admin'
  };

  const readCaller = {
    scopes: ['kaggle:read', 'tasks:read'],
    subjectId: 'user-reader'
  };

  await runTest('computeWorkspaceFingerprint computes canonical deterministic SHA', () => {
    const manifest1: DevSpaceProjectManifest = {
      name: 'Astor TuneUp',
      slug: 'astor-tuneup-project',
      version: 1,
      type: 'workspace',
      entrypoint: 'experiments/gate2c_9a_mining.py',
      runnerKernelRef: 'testuser/astor-tuneup-runner',
      files: {
        'src/b.py': { size: 20, sha256: '222' },
        'src/a.py': { size: 10, sha256: '111' }
      }
    };

    const manifest2: DevSpaceProjectManifest = {
      name: 'Astor TuneUp',
      slug: 'astor-tuneup-project',
      version: 1,
      type: 'workspace',
      entrypoint: 'experiments/gate2c_9a_mining.py',
      runnerKernelRef: 'testuser/astor-tuneup-runner',
      files: {
        'src/a.py': { size: 10, sha256: '111' },
        'src/b.py': { size: 20, sha256: '222' }
      }
    };

    const fp1 = computeWorkspaceFingerprint(manifest1);
    const fp2 = computeWorkspaceFingerprint(manifest2);
    assert.strictEqual(fp1, fp2);
    assert.strictEqual(fp1.length, 64);
  });

  await runTest('kaggle_workspace_get returns workspace manifest, files outline, and archive master', async () => {
    const res = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    assert.strictEqual(res.name, 'Astor TuneUp');
    assert.strictEqual(res.version, 1);
    assert.ok(res.workspaceFingerprint);
    assert.ok(res.archiveMaster);
    assert.strictEqual(res.archiveMaster.cellCount, 139);
    assert.strictEqual(res.archiveMaster.sha256, '9fb3664e184f0536f2fbbc31d53007c8eaa630c8391019934c3de015fc632450');
    assert.ok(res.files.length >= 10);
  });

  await runTest('kaggle_workspace_file retrieves file content with bounded chunking and sha256', async () => {
    const fileRes = await handlers.handleKaggleWorkspaceFile({
      project: 'testuser/astor-tuneup-project',
      path: 'PROJECT_CONTEXT.md',
      offset: 0,
      limit: 50
    }, readCaller);

    assert.strictEqual(fileRes.path, 'PROJECT_CONTEXT.md');
    assert.ok(fileRes.content.includes('Astor TuneUp'));
    assert.strictEqual(fileRes.offset, 0);
    assert.strictEqual(fileRes.limit, 50);
    assert.ok(fileRes.sha256);
    assert.strictEqual(fileRes.hasMore, true);
  });

  await runTest('kaggle_workspace_continue updates files, bumps version, and queues runner kernel', async () => {
    const getRes = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fp = getRes.workspaceFingerprint;

    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/astor-tuneup-project',
      expectedWorkspaceFingerprint: fp,
      changes: [
        {
          path: 'src/astor_tuneup/config.py',
          content: 'import os\nPROJECT_NAME = "Astor TuneUp"\nGATE_VERSION = "Gate2C-9A-v2"\n'
        }
      ],
      reason: 'Update Gate version to 9A-v2',
      clientRequestId: 'req-ws-001'
    }, adminCaller);

    assert.ok(continueRes.status === 'running' || continueRes.status === 'QUEUED' || continueRes.status === 'queued');
    assert.strictEqual(continueRes.workspaceVersion, 2);
    assert.strictEqual(continueRes.previousWorkspaceFingerprint, fp);
    assert.ok(continueRes.newWorkspaceFingerprint);
    assert.notStrictEqual(continueRes.newWorkspaceFingerprint, fp);
    assert.ok(continueRes.preWriteSnapshotId);
    assert.ok(continueRes.postWriteSnapshotId);
    assert.ok(continueRes.runnerKernelRef.includes('runner'));
  });

  await runTest('kaggle_workspace_continue rejects optimistic concurrency mismatch', async () => {
    let errCaught = false;
    try {
      await handlers.handleKaggleWorkspaceContinue({
        project: 'testuser/astor-tuneup-project',
        expectedWorkspaceFingerprint: 'outdated-fingerprint-1234567890',
        changes: [{ path: 'src/astor_tuneup/config.py', content: 'test' }],
        reason: 'Should fail'
      }, adminCaller);
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_WORKSPACE_CONFLICT'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_WORKSPACE_CONFLICT');
  });

  await runTest('kaggle_workspace_continue rejects unauthorized workspace owner modification', async () => {
    let errCaught = false;
    try {
      await handlers.handleKaggleWorkspaceContinue({
        project: 'otherowner/astor-tuneup-project',
        expectedWorkspaceFingerprint: 'any',
        changes: [{ path: 'src/astor_tuneup/config.py', content: 'test' }],
        reason: 'Should fail'
      }, adminCaller);
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_PROJECT_WRITE_FORBIDDEN'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_PROJECT_WRITE_FORBIDDEN');
  });

  await runTest('pre-rejects oversized kernel source (>1MB) in kaggle_project_continue and recommends workspace mode', async () => {
    const giantSource = 'print("giant")\n' + 'x = 1\n'.repeat(200000); // > 1MB
    assert.ok(giantSource.length > 1000000);

    let errCaught = false;
    try {
      await handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/mock-notebook',
        expectedCurrentFingerprint: 'dummy',
        mutation: {
          type: 'replace_source',
          source: giantSource
        },
        reason: 'Attempting giant source push'
      }, adminCaller);
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_KERNEL_SOURCE_TOO_LARGE'));
      assert.ok(err.message.includes('USE_KAGGLE_WORKSPACE_MODE'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_KERNEL_SOURCE_TOO_LARGE');
  });

  await runTest('pre-rejects oversized kernel source (>1MB) in kaggle_project_restore and recommends workspace mode', async () => {
    const giantSource = 'print("giant")\n' + 'x = 1\n'.repeat(200000); // > 1MB
    const sha = crypto.createHash('sha256').update(giantSource).digest('hex');

    let errCaught = false;
    try {
      await handlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/mock-notebook',
        kernelType: 'script',
        source: giantSource,
        sourceSha256: sha,
        reason: 'Attempting giant source restore'
      }, adminCaller);
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_KERNEL_SOURCE_TOO_LARGE'));
      assert.ok(err.message.includes('USE_KAGGLE_WORKSPACE_MODE'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_KERNEL_SOURCE_TOO_LARGE');
  });

  await runTest('rejects unauthorized or unauthenticated callers on workspace tools', async () => {
    let unauthCaught = false;
    try {
      await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, undefined);
    } catch (err: any) {
      unauthCaught = true;
      assert.ok(err.message.includes('AUTH_CONTEXT_REQUIRED'));
    }
    assert.ok(unauthCaught);

    const noWriteCaller = {
      scopes: ['kaggle:read'],
      subjectId: 'user-readonly'
    };

    let forbiddenCaught = false;
    try {
      await handlers.handleKaggleWorkspaceContinue({
        project: 'testuser/astor-tuneup-project',
        expectedWorkspaceFingerprint: 'any',
        changes: [{ path: 'a.py', content: 'b' }],
        reason: 'test'
      }, noWriteCaller);
    } catch (err: any) {
      forbiddenCaught = true;
      assert.ok(err.message.includes('AUTH_FORBIDDEN'));
    }
    assert.ok(forbiddenCaught);
  });

  return { passed, failed };
}
