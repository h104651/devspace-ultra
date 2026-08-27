import * as assert from 'assert';
import * as crypto from 'crypto';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import {
  computeProjectFingerprint,
  parseNotebookCells,
  appendCellsToNotebook,
  parseKernelRef
} from '../../src/kaggle/project-manager';
import { TaskStore } from '../../src/storage/task-store';
import { ArtifactStore } from '../../src/storage/artifact-store';
import { IdempotencyStore } from '../../src/storage/idempotency-store';
import { KaggleBackend } from '../../src/kaggle/backend';
import { TaskRouter } from '../../src/gateway/task-router';
import { McpHandlers } from '../../src/mcp/handlers';
import { KillSwitch } from '../../src/security/kill-switch';

export async function runKaggleProjectTests(): Promise<{ passed: number; failed: number }> {
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

  const gatewayFacade: any = {
    taskRouter,
    taskStore,
    artifactStore,
    kaggleBackend,
    authManager: { listDevices: () => [] },
    killSwitch
  };
  const handlers = new McpHandlers(gatewayFacade);

  const readAuth = { scopes: ['kaggle:read', 'tasks:read'], subjectId: 'user-1' };
  const submitAuth = { scopes: ['kaggle:submit', 'tasks:submit'], subjectId: 'user-1' };
  const writeForbiddenAuth = { scopes: ['local:write'], subjectId: 'user-1' };

  // 1. parseKernelRef
  await runTest('parseKernelRef parses owner/slug and bare slug', () => {
    const r1 = parseKernelRef('astorhsu/astor-tuneup', 'defaultuser');
    assert.strictEqual(r1.owner, 'astorhsu');
    assert.strictEqual(r1.slug, 'astor-tuneup');
    assert.strictEqual(r1.ref, 'astorhsu/astor-tuneup');

    const r2 = parseKernelRef('bare-slug', 'defaultuser');
    assert.strictEqual(r2.owner, 'defaultuser');
    assert.strictEqual(r2.slug, 'bare-slug');
    assert.strictEqual(r2.ref, 'defaultuser/bare-slug');
  });

  // 2. computeProjectFingerprint determinism
  await runTest('computeProjectFingerprint produces deterministic SHA-256 hash', () => {
    const params1 = {
      sourceSha256: 'abc123',
      kernelType: 'notebook',
      language: 'python',
      isPrivate: true,
      enableGpu: true,
      enableInternet: true,
      datasetSources: ['ds2', 'ds1'],
      competitionSources: [],
      kernelSources: [],
      modelSources: []
    };
    const fp1 = computeProjectFingerprint(params1);
    const fp2 = computeProjectFingerprint({
      ...params1,
      datasetSources: ['ds1', 'ds2'] // Different order
    });
    assert.strictEqual(fp1, fp2);
    assert.strictEqual(typeof fp1, 'string');
    assert.strictEqual(fp1.length, 64);
  });

  // 3. parseNotebookCells & appendCellsToNotebook
  await runTest('appendCellsToNotebook preserves existing structure and appends cells', () => {
    const initialNb = JSON.stringify({
      cells: [
        { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['x = 10\n'] }
      ],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    });

    const mutated = appendCellsToNotebook(initialNb, [
      { cellType: 'markdown', source: '# Step 2' },
      { cellType: 'code', source: 'print(x * 2)' }
    ]);

    const parsed = JSON.parse(mutated);
    assert.strictEqual(parsed.cells.length, 3);
    assert.strictEqual(parsed.cells[0].cell_type, 'code');
    assert.strictEqual(parsed.cells[1].cell_type, 'markdown');
    assert.strictEqual(parsed.cells[1].source[0], '# Step 2\n');
    assert.strictEqual(parsed.cells[2].cell_type, 'code');
    assert.strictEqual(parsed.cells[2].source[0], 'print(x * 2)\n');
    assert.strictEqual(parsed.nbformat, 4);
    assert.strictEqual(parsed.nbformat_minor, 5);
  });

  // 4. handleKaggleProjectList
  await runTest('handleKaggleProjectList returns project list with search', async () => {
    const listRes = await handlers.handleKaggleProjectList({ search: 'tuneup' }, readAuth);
    assert.strictEqual(listRes.total, 1);
    assert.strictEqual(listRes.projects[0].slug, 'astor-tuneup');
    assert.strictEqual(listRes.projects[0].kernelType, 'notebook');
  });

  // 5. handleKaggleProjectGet
  await runTest('handleKaggleProjectGet returns metadata, sha256 and concurrency fingerprint', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    assert.strictEqual(getRes.slug, 'astor-tuneup');
    assert.strictEqual(getRes.kernelType, 'notebook');
    assert.strictEqual(getRes.enableGpu, true);
    assert.strictEqual(getRes.enableInternet, true);
    assert.strictEqual(typeof getRes.sourceSha256, 'string');
    assert.strictEqual(getRes.sourceSha256.length, 64);
    assert.strictEqual(typeof getRes.projectFingerprint, 'string');
    assert.strictEqual(getRes.projectFingerprint.length, 64);
  });

  // 6. handleKaggleProjectSource pagination and cells
  await runTest('handleKaggleProjectSource chunks content and returns structured notebook cells', async () => {
    const srcRes = await handlers.handleKaggleProjectSource({ kernelRef: 'testuser/astor-tuneup', offset: 0, limit: 100 }, readAuth);
    assert.strictEqual(srcRes.sourceFormat, 'ipynb');
    assert.strictEqual(srcRes.offset, 0);
    assert.strictEqual(srcRes.content.length <= 100, true);
    assert.strictEqual(Array.isArray(srcRes.cells), true);
    assert.strictEqual(srcRes.cells!.length >= 1, true);
    assert.strictEqual(srcRes.cells![0].cellType, 'code');
  });

  // 7. handleKaggleProjectFiles
  await runTest('handleKaggleProjectFiles returns output files metadata', async () => {
    const filesRes = await handlers.handleKaggleProjectFiles({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    assert.strictEqual(filesRes.filesCount, 2);
    assert.strictEqual(filesRes.files[0].name, 'stdout.log');
    assert.strictEqual(filesRes.files[1].name, 'metrics.json');
  });

  // 8. handleKaggleProjectOutput
  await runTest('handleKaggleProjectOutput returns output content inline', async () => {
    const outRes = await handlers.handleKaggleProjectOutput({ kernelRef: 'testuser/astor-tuneup', filePattern: 'stdout' }, readAuth);
    assert.strictEqual(outRes.fileName, 'stdout.log');
    assert.strictEqual(outRes.content!.includes('Mock Kaggle output'), true);
  });

  // 9. handleKaggleProjectLogs
  await runTest('handleKaggleProjectLogs returns log lines', async () => {
    const logsRes = await handlers.handleKaggleProjectLogs({ kernelRef: 'testuser/astor-tuneup', limit: 10 }, readAuth);
    assert.strictEqual(logsRes.available, true);
    assert.strictEqual(logsRes.logs.length, 2);
  });

  // 10. Scope Enforcement on Read Tools
  await runTest('Scope enforcement: Read tools reject unauthorized callers', async () => {
    await assert.rejects(
      async () => handlers.handleKaggleProjectList({}, writeForbiddenAuth),
      /AUTH_FORBIDDEN/
    );
    await assert.rejects(
      async () => handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, writeForbiddenAuth),
      /AUTH_FORBIDDEN/
    );
    await assert.rejects(
      async () => handlers.handleKaggleProjectSource({ kernelRef: 'testuser/astor-tuneup' }, writeForbiddenAuth),
      /AUTH_FORBIDDEN/
    );
  });

  // 11. Ownership Protection in Continue
  await runTest('Ownership protection: Reject modifying kernel owned by another user', async () => {
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue(
        {
          kernelRef: 'otheruser/their-kernel',
          expectedProjectFingerprint: 'any',
          mutation: { type: 'append_script', code: 'print(1)' }
        },
        submitAuth
      ),
      /KAGGLE_PROJECT_WRITE_FORBIDDEN/
    );
  });

  // 12. Conflict Protection in Continue (Stale Fingerprint)
  await runTest('Conflict protection: Reject continue when fingerprint does not match', async () => {
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue(
        {
          kernelRef: 'testuser/astor-tuneup',
          expectedProjectFingerprint: 'stale-wrong-fingerprint',
          mutation: { type: 'append_notebook_cells', cells: [{ cellType: 'code', source: 'print(1)' }] }
        },
        submitAuth
      ),
      /KAGGLE_PROJECT_CONFLICT/
    );
  });

  // 13. Successful Continue with append_notebook_cells
  await runTest('Successful continue with append_notebook_cells submits durable task', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const continueRes = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print("Continuation Step 1")' }]
        },
        clientRequestId: 'req-proj-1'
      },
      submitAuth
    );

    assert.strictEqual(continueRes.status, 'running');
    assert.strictEqual(continueRes.kernelRef, 'testuser/astor-tuneup');
    assert.strictEqual(continueRes.previousProjectFingerprint, getRes.projectFingerprint);
    assert.strictEqual(typeof continueRes.submittedSourceSha256, 'string');
  });

  // 14. Idempotent Replay on Continue
  await runTest('Idempotent replay on continue returns existing task without duplicate execution', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const replayRes = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print("Continuation Step 1")' }]
        },
        clientRequestId: 'req-proj-1'
      },
      submitAuth
    );

    assert.strictEqual(replayRes.isReplay, true);
  });

  // 15. Successful Continue with append_script
  await runTest('Successful continue with append_script preserves script and appends code', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/devspace-project-control-e2e' }, readAuth);
    const continueRes = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/devspace-project-control-e2e',
        expectedProjectFingerprint: getRes.projectFingerprint,
        mutation: {
          type: 'append_script',
          code: 'print("Appended script test")'
        },
        clientRequestId: 'req-proj-script-1'
      },
      submitAuth
    );

    assert.strictEqual(continueRes.status, 'running');
    assert.strictEqual(continueRes.kernelRef, 'testuser/devspace-project-control-e2e');
  });

  return { passed, failed };
}
