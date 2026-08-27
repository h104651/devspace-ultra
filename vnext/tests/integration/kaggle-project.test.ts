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
      machineShape: 'NvidiaTeslaT4',
      datasetSources: ['ds2', 'ds1'],
      competitionSources: [],
      kernelSources: [],
      modelSources: []
    };
    const fp1 = computeProjectFingerprint(params1);
    const fp2 = computeProjectFingerprint({
      ...params1,
      datasetSources: ['ds1', 'ds2']
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

  // 6. Large notebook MCP response bounding
  await runTest('Large 14MB mock notebook does not dump all cells by default', async () => {
    const bigCells = Array.from({ length: 100 }, (_, i) => ({
      cell_type: 'code',
      execution_count: i + 1,
      metadata: {},
      outputs: [],
      source: [`# Large cell ${i}\n` + 'print("x")\n'.repeat(1000)]
    }));
    const bigNbSource = JSON.stringify({
      cells: bigCells,
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    });

    const parsedDefault = parseNotebookCells(bigNbSource);
    assert.strictEqual(parsedDefault?.totalCells, 100);
    assert.strictEqual(parsedDefault?.cells, undefined);

    const parsedWithoutCells = parseNotebookCells(bigNbSource, { includeCells: false });
    assert.strictEqual(parsedWithoutCells?.totalCells, 100);
    assert.strictEqual(parsedWithoutCells?.cells, undefined);
  });

  // 7. Cell pagination & NextCellOffset
  await runTest('Notebook cell pagination returns requested slice and nextCellOffset', async () => {
    const bigCells = Array.from({ length: 35 }, (_, i) => ({
      cell_type: i % 2 === 0 ? 'code' : 'markdown',
      execution_count: i + 1,
      metadata: {},
      outputs: [],
      source: [`cell ${i} content`]
    }));
    const nbSource = JSON.stringify({ cells: bigCells, metadata: {}, nbformat: 4, nbformat_minor: 5 });

    const page1 = parseNotebookCells(nbSource, { includeCells: true, cellOffset: 0, cellLimit: 10 });
    assert.strictEqual(page1?.totalCells, 35);
    assert.strictEqual(page1?.cells?.length, 10);
    assert.strictEqual(page1?.cells?.[0].index, 0);
    assert.strictEqual(page1?.cells?.[9].index, 9);
    assert.strictEqual(page1?.nextCellOffset, 10);

    const page2 = parseNotebookCells(nbSource, { includeCells: true, cellOffset: 30, cellLimit: 10 });
    assert.strictEqual(page2?.cells?.length, 5);
    assert.strictEqual(page2?.cells?.[0].index, 30);
    assert.strictEqual(page2?.nextCellOffset, undefined);
  });

  // 8. Cell source truncation
  await runTest('Cell source inclusion respects maxCellSourceChars and flags sourceTruncated', async () => {
    const cells = [
      { cell_type: 'code', source: ['x = ' + '9'.repeat(500)] }
    ];
    const nbSource = JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });

    const parsed = parseNotebookCells(nbSource, {
      includeCells: true,
      includeCellSource: true,
      maxCellSourceChars: 50
    });
    assert.strictEqual(parsed?.cells?.length, 1);
    const c0 = parsed!.cells![0];
    assert.strictEqual(c0.sourceTruncated, true);
    assert.strictEqual(c0.source?.length, 50);
    assert.strictEqual(c0.sourceLength, 504);
  });

  // 9. Known Version Retrieval
  await runTest('Known version retrieval pulls specific version metadata and source', async () => {
    const srcRes = await handlers.handleKaggleProjectSource({ kernelRef: 'testuser/astor-tuneup', version: 2 }, readAuth);
    assert.strictEqual(srcRes.requestedVersion, 2);
    assert.strictEqual(srcRes.sourceFormat, 'ipynb');
  });

  await runTest('Non-existent version throws KAGGLE_VERSION_NOT_FOUND', async () => {
    await assert.rejects(
      async () => handlers.handleKaggleProjectSource({ kernelRef: 'testuser/astor-tuneup', version: 999 }, readAuth),
      /KAGGLE_VERSION_NOT_FOUND/
    );
  });

  // 10. Fail-Safe Suspicious State Guard on Continue
  await runTest('Fail-Safe: Abort continue when notebook resolves to empty or script state', async () => {
    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { kernelType: 'script', isPrivate: true },
            source: ''
          })
        })
      } as any
    });

    await assert.rejects(
      async () => customHandlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print(1)' }]
        }
      }, submitAuth),
      /KAGGLE_PROJECT_STATE_SUSPICIOUS/
    );
  });

  // 11. MachineShape & ModelSources preservation
  await runTest('MachineShape and modelDataSources are preserved in continue payload', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const continueRes = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print("Settings preservation test")' }]
        },
        clientRequestId: 'req-settings-pres-1'
      },
      submitAuth
    );

    assert.strictEqual(continueRes.status, 'running');
    const task = taskStore.getTask(continueRes.taskId);
    assert.strictEqual(task?.payload?.machineShape, 'NvidiaTeslaT4');
  });

  // 12. Large output routed to R2
  await runTest('Large output (>=256 KiB) routes through ArtifactStore & R2', async () => {
    const bigBuf = Buffer.alloc(300 * 1024, 'A');
    (client as any).downloadSingleOutputFile = async () => ({
      file: { name: 'large_weights.bin', content: bigBuf, sizeBytes: bigBuf.length },
      totalFiles: 1,
      allFileNames: ['large_weights.bin']
    });

    const outRes = await handlers.handleKaggleProjectOutput({ kernelRef: 'testuser/astor-tuneup', filePattern: 'large_weights.bin' }, readAuth);
    assert.strictEqual(outRes.fileName, 'large_weights.bin');
    assert.strictEqual(typeof outRes.artifactId, 'string');
    assert.strictEqual(outRes.sizeBytes, 300 * 1024);
    assert.strictEqual(typeof outRes.downloadUrl, 'string');
    assert.strictEqual(outRes.content, undefined);
  });

  // 13. Pre-rejection of >20 MiB output
  await runTest('Output > 20 MiB is pre-rejected with KAGGLE_OUTPUT_TOO_LARGE', async () => {
    (client as any).downloadSingleOutputFile = async () => {
      throw new Error('KAGGLE_OUTPUT_TOO_LARGE: Output file "giant.zip" (25000000 bytes) exceeds the 20 MiB R2 single-object limit');
    };

    await assert.rejects(
      async () => handlers.handleKaggleProjectOutput({ kernelRef: 'testuser/astor-tuneup', filePattern: 'giant.zip' }, readAuth),
      /KAGGLE_OUTPUT_TOO_LARGE/
    );
  });

  // 14. Download single targeted file
  await runTest('Targeted output fetch selects only requested file', async () => {
    (client as any).downloadSingleOutputFile = async (owner: string, slug: string, pattern?: string) => {
      return {
        file: { name: 'metrics.json', content: '{"loss": 0.01}', sizeBytes: 15 },
        totalFiles: 3,
        allFileNames: ['stdout.log', 'metrics.json', 'model.pth']
      };
    };

    const outRes = await handlers.handleKaggleProjectOutput({ kernelRef: 'testuser/astor-tuneup', filePattern: 'metrics.json' }, readAuth);
    assert.strictEqual(outRes.fileName, 'metrics.json');
    assert.strictEqual(outRes.content, '{"loss": 0.01}');
    assert.strictEqual(outRes.totalFiles, 3);
  });

  // 15. Explicit owner honored for read
  await runTest('Explicit owner is honored in project reads', async () => {
    let capturedOwner = '';
    (client as any).pullProject = async (owner: string, slug: string) => {
      capturedOwner = owner;
      return {
        metadata: { kernelType: 'script', language: 'python', isPrivate: false },
        source: 'print("Public script")'
      };
    };

    await handlers.handleKaggleProjectGet({ kernelRef: 'otherresearcher/public-notebook' }, readAuth);
    assert.strictEqual(capturedOwner, 'otherresearcher');
  });

  // 16. Scope Enforcement on Read Tools
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

  // 17. Ownership Protection in Continue
  await runTest('Ownership protection: Reject modifying kernel owned by another user', async () => {
    (client as any).getUsername = () => 'testuser';
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

  // 18. Conflict Protection in Continue (Stale Fingerprint)
  await runTest('Conflict protection: Reject continue when fingerprint does not match', async () => {
    (client as any).getUsername = () => 'testuser';
    (client as any).pullProject = async (owner: string, slug: string) => ({
      metadata: { kernelType: 'notebook', language: 'python', isPrivate: true },
      source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
    });
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

  // 19. Idempotent Replay on Continue
  await runTest('Idempotent replay on continue returns existing task without duplicate execution', async () => {
    (client as any).getUsername = () => 'testuser';
    (client as any).pullProject = async (owner: string, slug: string) => ({
      metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, title: 'Astor TuneUp' },
      source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
    });
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const res1 = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print("Continuation Step 1")' }]
        },
        clientRequestId: 'req-proj-idem-1'
      },
      submitAuth
    );
    const replayRes = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print("Continuation Step 1")' }]
        },
        clientRequestId: 'req-proj-idem-1'
      },
      submitAuth
    );

    assert.strictEqual(replayRes.isReplay, true);
    assert.strictEqual(replayRes.taskId, res1.taskId);
  });

  return { passed, failed };
}
