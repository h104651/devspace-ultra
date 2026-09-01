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
import { getCanonicalToolsList, KAGGLE_PROJECT_RESTORE_SCHEMA } from '../../src/mcp/tools';

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
            metadata: { kernelType: 'script', language: 'python', isPrivate: true, enableGpu: false, enableInternet: true },
            source: ''
          })
        })
      } as any
    });

    await assert.rejects(
      async () => customHandlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print(1)' }]
        }
      }, submitAuth),
      /KAGGLE_PROJECT_STATE_SUSPICIOUS|KAGGLE_MUTATION_KERNEL_TYPE_MISMATCH/
    );
  });

  // 11. Explicit Restore: Happy Path & Override of Suspicious State
  await runTest('Explicit Restore: Overrides suspicious remote state and submits restore task with snapshots', async () => {
    const trustedNb = JSON.stringify({
      cells: [
        { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['print("Restored notebook master")\n'] }
      ],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    });
    const trustedSha = crypto.createHash('sha256').update(trustedNb).digest('hex');

    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { kernelType: 'script', language: 'python', isPrivate: true, enableGpu: false, enableInternet: true, title: 'Corrupted Script' },
            source: ''
          })
        })
      } as any
    });

    const getRes = await customHandlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const restoreRes = await customHandlers.handleKaggleProjectRestore({
      kernelRef: 'testuser/astor-tuneup',
      expectedCurrentFingerprint: getRes.projectFingerprint,
      source: trustedNb,
      sourceSha256: trustedSha,
      kernelType: 'notebook',
      allowKernelTypeChange: true,
      kernelTypeChangeReason: 'Recover corrupted script back to canonical notebook',
      acknowledgeUnobservedBrowserDraft: true,
      reason: 'Disaster recovery from verified local backup',
      clientRequestId: 'req-restore-test-1'
    }, submitAuth);

    assert.strictEqual(restoreRes.status, 'running');
    assert.strictEqual(restoreRes.kernelRef, 'testuser/astor-tuneup');
    assert.strictEqual(restoreRes.restoredSourceSha256, trustedSha);
    assert.strictEqual(typeof restoreRes.preWriteSnapshotId, 'string');
    assert.strictEqual(typeof restoreRes.postWriteSnapshotId, 'string');
  });

  // 12. Explicit Restore: Rejects SHA Mismatch
  await runTest('Explicit Restore: Rejects source if provided SHA-256 does not match computed SHA', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    await assert.rejects(
      async () => handlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        expectedCurrentFingerprint: getRes.projectFingerprint,
        source: 'print("Fake source")',
        sourceSha256: 'wrong00000000000000000000000000000000000000000000000000000000000',
        kernelType: 'script',
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Testing mismatch'
      }, submitAuth),
      /RECOVERY_MASTER_SHA_MISMATCH/
    );
  });

  // 13. Explicit Restore: Rejects Foreign Owner
  await runTest('Explicit Restore: Rejects restoring kernel owned by another user', async () => {
    await assert.rejects(
      async () => handlers.handleKaggleProjectRestore({
        kernelRef: 'otheruser/their-kernel',
        expectedCurrentFingerprint: 'any',
        source: 'print(1)',
        sourceSha256: crypto.createHash('sha256').update('print(1)').digest('hex'),
        kernelType: 'script',
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Unauthorized restore'
      }, submitAuth),
      /KAGGLE_PROJECT_WRITE_FORBIDDEN/
    );
  });

  // 14. MachineShape & ModelSources preservation
  await runTest('MachineShape and modelDataSources are preserved in continue payload', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const continueRes = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        acknowledgeUnobservedBrowserDraft: true,
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

  // 15. Large output routed to R2
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

  // 16. Pre-rejection of >20 MiB output
  await runTest('Output > 20 MiB is pre-rejected with KAGGLE_OUTPUT_TOO_LARGE', async () => {
    (client as any).downloadSingleOutputFile = async () => {
      throw new Error('KAGGLE_OUTPUT_TOO_LARGE: Output file "giant.zip" (25000000 bytes) exceeds the 20 MiB R2 single-object limit');
    };

    await assert.rejects(
      async () => handlers.handleKaggleProjectOutput({ kernelRef: 'testuser/astor-tuneup', filePattern: 'giant.zip' }, readAuth),
      /KAGGLE_OUTPUT_TOO_LARGE/
    );
  });

  // 17. Download single targeted file
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

  // 18. Explicit owner honored for read
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

  // 19. Scope Enforcement on Read Tools
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

  // 20. Ownership Protection in Continue
  await runTest('Ownership protection: Reject modifying kernel owned by another user', async () => {
    (client as any).getUsername = () => 'testuser';
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue(
        {
          kernelRef: 'otheruser/their-kernel',
          expectedProjectFingerprint: 'any',
          acknowledgeUnobservedBrowserDraft: true,
          mutation: { type: 'append_script', code: 'print(1)' }
        },
        submitAuth
      ),
      /KAGGLE_PROJECT_WRITE_FORBIDDEN/
    );
  });

  // 21. Conflict Protection in Continue (Stale Fingerprint)
  await runTest('Conflict protection: Reject continue when fingerprint does not match', async () => {
    (client as any).getUsername = () => 'testuser';
    (client as any).pullProject = async (owner: string, slug: string) => ({
      metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
      source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
    });
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue(
        {
          kernelRef: 'testuser/astor-tuneup',
          expectedProjectFingerprint: 'stale-wrong-fingerprint',
          acknowledgeUnobservedBrowserDraft: true,
          mutation: { type: 'append_notebook_cells', cells: [{ cellType: 'code', source: 'print(1)' }] }
        },
        submitAuth
      ),
      /KAGGLE_PROJECT_CONFLICT/
    );
  });

  // 22. Idempotent Replay on Continue
  await runTest('Idempotent replay on continue returns existing task without duplicate execution', async () => {
    (client as any).getUsername = () => 'testuser';
    (client as any).pullProject = async (owner: string, slug: string) => ({
      metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true, title: 'Astor TuneUp' },
      source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
    });
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    const res1 = await handlers.handleKaggleProjectContinue(
      {
        kernelRef: 'testuser/astor-tuneup',
        expectedProjectFingerprint: getRes.projectFingerprint,
        acknowledgeUnobservedBrowserDraft: true,
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
        acknowledgeUnobservedBrowserDraft: true,
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

  // ==========================================
  // P0-1: NOTEBOOK / SCRIPT SOURCE FORMAT SAFETY
  // ==========================================
  await runTest('P0-1: Existing Notebook + replace_source with raw python is REJECTED with 0 pushes', async () => {
    let pushCount = 0;
    const testKaggleClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/astor-tuneup' }; }
    };
    const testBackend = new KaggleBackend(taskStore, artifactStore, testKaggleClient);
    const testHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: testBackend });

    await assert.rejects(
      async () => testHandlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'replace_source',
          source: 'print("raw python script")'
        }
      }, submitAuth),
      /KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID/
    );
    assert.strictEqual(pushCount, 0, 'Kaggle push count must be 0');
  });

  await runTest('P0-1: Existing Notebook + valid ipynb replace_source is ACCEPTED', async () => {
    const validNb = JSON.stringify({
      cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['print("Valid new notebook")\n'] }],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    });
    const res = await handlers.handleKaggleProjectContinue({
      kernelRef: 'testuser/astor-tuneup',
      acknowledgeUnobservedBrowserDraft: true,
      mutation: {
        type: 'replace_source',
        source: validNb
      }
    }, submitAuth);
    assert.strictEqual(res.status, 'running');
  });

  await runTest('P0-1: Script project + append_notebook_cells is REJECTED', async () => {
    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { kernelType: 'script', language: 'python', isPrivate: true, enableGpu: false, enableInternet: true },
            source: 'print("Original script")\n'
          })
        })
      } as any
    });

    await assert.rejects(
      async () => customHandlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print(1)' }]
        }
      }, submitAuth),
      /KAGGLE_MUTATION_KERNEL_TYPE_MISMATCH/
    );
  });

  // ==========================================
  // P0-2: RESTORE KERNEL-TYPE PRESERVATION
  // ==========================================
  await runTest('P0-2: Restore Notebook -> Script without allowKernelTypeChange is REJECTED', async () => {
    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
            source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
          })
        })
      } as any
    });

    await assert.rejects(
      async () => customHandlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        source: 'print("New script")',
        sourceSha256: crypto.createHash('sha256').update('print("New script")').digest('hex'),
        kernelType: 'script',
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Attempting to change kernelType without authorization'
      }, submitAuth),
      /KAGGLE_KERNEL_TYPE_CHANGE_FORBIDDEN/
    );
  });

  await runTest('P0-2: Restore Notebook -> Script with explicit allowKernelTypeChange and reason PASSES', async () => {
    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
            source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
          })
        })
      } as any
    });

    const res = await customHandlers.handleKaggleProjectRestore({
      kernelRef: 'testuser/astor-tuneup',
      source: 'print("New script")',
      sourceSha256: crypto.createHash('sha256').update('print("New script")').digest('hex'),
      kernelType: 'script',
      allowKernelTypeChange: true,
      kernelTypeChangeReason: 'Authorized migration from notebook to script',
      acknowledgeUnobservedBrowserDraft: true,
      reason: 'Migrating codebase'
    }, submitAuth);
    assert.strictEqual(res.status, 'running');
  });

  // ==========================================
  // P0-3: EXTERNAL RUN STATE & RECONCILIATION
  // ==========================================
  await runTest('P0-3: Generic stale recovery skips external Kaggle runs', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => ({ status: 'running' })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    assert.strictEqual(pushCount, 1);
    assert.strictEqual(task.externalRun?.provider, 'kaggle');
    assert.strictEqual(task.externalRun?.reconciliationState, 'active');

    // Force task lease expiration
    tStore.updateTask(task.taskId, {
      lease: { claimedBy: 'worker-1', claimedAt: Date.now() - 120000, leaseExpiresAt: Date.now() - 60000, lastHeartbeatAt: Date.now() - 120000 }
    });

    // Generic stale recovery run
    const recResult = tStore.recoverStaleTasks();
    assert.strictEqual(recResult.recoveredCount, 0);
    assert.strictEqual(recResult.failedCount, 0);

    const taskAfter = tStore.getTask(task.taskId);
    assert.strictEqual(taskAfter?.status, 'running');
    assert.strictEqual(pushCount, 1, 'No second submission occurred');
  });

  await runTest('P0-3: ReconcileTask: Remote COMPLETE finalizes task with zero re-push', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 2 }; },
      getKernelStatus: async () => ({ status: 'complete' }),
      downloadKernelOutput: async () => ({ success: true, files: [{ name: 'result.json', content: '{"acc": 0.99}' }] })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    const needMore = await tBackend.reconcileTask(task.taskId);
    assert.strictEqual(needMore, false);

    const finishedTask = tStore.getTask(task.taskId);
    assert.strictEqual(finishedTask?.status, 'succeeded');
    assert.strictEqual(finishedTask?.externalRun?.reconciliationState, 'completed');
    assert.strictEqual(pushCount, 1, 'Zero re-push occurred');
  });

  await runTest('P0-3: ReconcileTask: Remote RUNNING preserves active state with zero re-push', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 2 }; },
      getKernelStatus: async () => ({ status: 'running', rawMessage: 'Training epoch 5' })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    const needMore = await tBackend.reconcileTask(task.taskId);
    assert.strictEqual(needMore, true);

    const runningTask = tStore.getTask(task.taskId);
    assert.strictEqual(runningTask?.status, 'running');
    assert.strictEqual(runningTask?.externalRun?.lastRemoteStatus, 'running');
    assert.strictEqual(pushCount, 1, 'Zero re-push occurred');
  });

  await runTest('P0-3: ReconcileTask: Remote UNKNOWN / Network error sets pending state with zero re-push', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 2 }; },
      getKernelStatus: async () => { throw new Error('Transient 502 Bad Gateway'); }
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    const needMore = await tBackend.reconcileTask(task.taskId);
    assert.strictEqual(needMore, true);

    const pendingTask = tStore.getTask(task.taskId);
    assert.strictEqual(pendingTask?.status, 'running');
    assert.strictEqual(pendingTask?.externalRun?.reconciliationState, 'pending');
    assert.strictEqual(pushCount, 1, 'Zero re-push occurred');
  });

  // ==========================================
  // BLOCKERS 1 & 2: TERMINAL ERRORS & CANCELLATION
  // ==========================================
  await runTest('Blocker 1 & 2: Remote ERROR is terminal, bypasses generic retry (no requeue), zero re-push', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => ({ status: 'error', rawMessage: 'SyntaxError: unexpected EOF' })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      maxRetries: 3,
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    const needMore = await tBackend.reconcileTask(task.taskId);
    assert.strictEqual(needMore, false);

    const failedTask = tStore.getTask(task.taskId);
    assert.strictEqual(failedTask?.status, 'failed');
    assert.strictEqual(failedTask?.retryPolicy.retryCount, 0, 'Generic retry must be bypassed');
    assert.strictEqual(failedTask?.externalRun?.reconciliationState, 'failed');
    assert.strictEqual(pushCount, 1, 'Zero re-push occurred');
  });

  await runTest('Blocker 1 & 2: Remote quotaExceeded is terminal, zero re-push', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => ({ status: 'quotaExceeded', rawMessage: 'GPU limit reached' })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      maxRetries: 3,
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    const needMore = await tBackend.reconcileTask(task.taskId);
    assert.strictEqual(needMore, false);

    const failedTask = tStore.getTask(task.taskId);
    assert.strictEqual(failedTask?.status, 'failed');
    assert.strictEqual(failedTask?.retryPolicy.retryCount, 0);
    assert.strictEqual(failedTask?.error?.code, 'RESOURCE_QUOTA_EXCEEDED');
    assert.strictEqual(pushCount, 1, 'Zero re-push occurred');
  });

  await runTest('Blocker 1: Remote cancelled maps to local terminal cancelled, zero re-push', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => ({ status: 'cancelled', rawMessage: 'Cancelled by user' })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });

    await tBackend.submitKaggleTask(task);
    const needMore = await tBackend.reconcileTask(task.taskId);
    assert.strictEqual(needMore, false);

    const cancelledTask = tStore.getTask(task.taskId);
    assert.strictEqual(cancelledTask?.status, 'cancelled');
    assert.strictEqual(cancelledTask?.externalRun?.reconciliationState, 'failed');
    assert.strictEqual(pushCount, 1, 'Zero re-push occurred');
  });

  // ==========================================
  // BLOCKER 3: STARTUP / HYDRATION RECONCILIATION
  // ==========================================
  await runTest('Blocker 3: Hydration reconcileDanglingTasks discovers non-terminal Kaggle run and finalizes remote COMPLETE', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => ({ status: 'complete' }),
      downloadKernelOutput: async () => ({ success: true, files: [{ name: 'out.txt', content: 'done' }] })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);

    // 1. Create and submit external task
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });
    await tBackend.submitKaggleTask(task);
    assert.strictEqual(pushCount, 1);

    // 2. Simulate process/DO restart & hydration into fresh TaskStore
    const serializedTasks = tStore.listTasks();
    const hydratedStore = new TaskStore();
    hydratedStore.hydrate(serializedTasks);
    hydratedStore.recoverStaleTasks();

    const hydratedBackend = new KaggleBackend(hydratedStore, aStore, testKClient);

    // 3. Production startup discovers dangling Kaggle task and reconciles
    const reconResult = await hydratedBackend.reconcileDanglingTasks();
    assert.strictEqual(reconResult.reconciledCount, 1);

    const finalized = hydratedStore.getTask(task.taskId);
    assert.strictEqual(finalized?.status, 'succeeded');
    assert.strictEqual(finalized?.externalRun?.reconciliationState, 'completed');
    assert.strictEqual(pushCount, 1, 'Zero re-push after restart/hydration');
  });

  await runTest('Blocker 3: Hydration reconcileDanglingTasks handles remote RUNNING without repush', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => ({ status: 'running', rawMessage: 'Running epoch 1' })
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });
    await tBackend.submitKaggleTask(task);

    // Simulate restart
    const hydratedStore = new TaskStore();
    hydratedStore.hydrate(tStore.listTasks());
    const hydratedBackend = new KaggleBackend(hydratedStore, aStore, testKClient);

    const reconResult = await hydratedBackend.reconcileDanglingTasks();
    assert.strictEqual(reconResult.reconciledCount, 1);

    const running = hydratedStore.getTask(task.taskId);
    assert.strictEqual(running?.status, 'running');
    assert.strictEqual(running?.externalRun?.lastRemoteStatus, 'running');
    assert.strictEqual(pushCount, 1, 'Zero re-push');
  });

  await runTest('Blocker 3: Hydration reconcileDanglingTasks handles remote UNKNOWN/network failure without repush', async () => {
    const tStore = new TaskStore();
    const aStore = new ArtifactStore();
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/test-k', versionNumber: 1 }; },
      getKernelStatus: async () => { throw new Error('Network timeout'); }
    };
    const tBackend = new KaggleBackend(tStore, aStore, testKClient);
    const task = tStore.createTask({
      backend: 'kaggle',
      capability: 'kaggle:run',
      payload: { kernelSlug: 'testuser/test-k', code: 'print(1)', language: 'python' as const, kernelType: 'script' as const }
    });
    await tBackend.submitKaggleTask(task);

    // Simulate restart
    const hydratedStore = new TaskStore();
    hydratedStore.hydrate(tStore.listTasks());
    const hydratedBackend = new KaggleBackend(hydratedStore, aStore, testKClient);

    const reconResult = await hydratedBackend.reconcileDanglingTasks();
    assert.strictEqual(reconResult.reconciledCount, 1);

    const pending = hydratedStore.getTask(task.taskId);
    assert.strictEqual(pending?.status, 'running');
    assert.strictEqual(pending?.externalRun?.reconciliationState, 'pending');
    assert.strictEqual(pushCount, 1, 'Zero re-push');
  });

  // ==========================================
  // BLOCKER 4: UNKNOWN SETTINGS FAIL CLOSED
  // ==========================================
  await runTest('Blocker 4: Unknown settings fail closed with KAGGLE_PROJECT_SETTINGS_UNKNOWN on continue', async () => {
    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { title: 'Test', isPrivate: true, language: 'python', kernelType: 'notebook' }, // missing enableGpu & enableInternet
            source: JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1'] }], nbformat: 4, nbformat_minor: 5 })
          })
        })
      } as any
    });

    await assert.rejects(
      async () => customHandlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print(1)' }]
        }
      }, submitAuth),
      /KAGGLE_PROJECT_SETTINGS_UNKNOWN/
    );
  });

  await runTest('Blocker 4: Unknown settings fail closed with KAGGLE_PROJECT_SETTINGS_UNKNOWN on restore', async () => {
    const customHandlers = new McpHandlers({
      ...gatewayFacade,
      kaggleBackend: {
        getClient: () => ({
          getUsername: () => 'testuser',
          pullProject: async () => ({
            metadata: { title: 'Test', isPrivate: true }, // missing enableGpu, enableInternet, language, kernelType
            source: 'print(1)'
          })
        })
      } as any
    });

    await assert.rejects(
      async () => customHandlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        source: 'print("Restored")',
        sourceSha256: crypto.createHash('sha256').update('print("Restored")').digest('hex'),
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Restoring'
      }, submitAuth),
      /KAGGLE_PROJECT_SETTINGS_UNKNOWN/
    );
  });

  // ==========================================
  // BLOCKER 5: SHARED NOTEBOOK VALIDATOR
  // ==========================================
  await runTest('Blocker 5: Shared notebook validator rejects missing nbformat', async () => {
    const invalidNb = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'] }]
    });
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'replace_source',
          source: invalidNb
        }
      }, submitAuth),
      /KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID/
    );
  });

  await runTest('Blocker 5: Shared notebook validator rejects invalid float or unsupported nbformat', async () => {
    const floatNb = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'] }],
      nbformat: 4.5
    });
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'replace_source',
          source: floatNb
        }
      }, submitAuth),
      /KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID/
    );

    const oldNb = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['print(1)'] }],
      nbformat: 3
    });
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'replace_source',
          source: oldNb
        }
      }, submitAuth),
      /KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID/
    );
  });

  await runTest('Blocker 5: Shared notebook validator rejects missing cells array', async () => {
    const noCellsNb = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5
    });
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'replace_source',
          source: noCellsNb
        }
      }, submitAuth),
      /KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID/
    );
  });

  // ==========================================
  // P0-4: PRIVACY TRI-STATE & METADATA
  // ==========================================
  await runTest('P0-4: Project get returns tri-state privacy and metadata', async () => {
    const getRes = await handlers.handleKaggleProjectGet({ kernelRef: 'testuser/astor-tuneup' }, readAuth);
    assert.strictEqual(typeof getRes.isPrivate, 'boolean');
    assert.strictEqual(getRes.privacyKnown, true);
    assert.strictEqual(getRes.privacySource, 'kaggle_metadata');
    assert.strictEqual(getRes.persistedSourceVisibility, 'AVAILABLE');
    assert.strictEqual(getRes.browserDraftVisibility, 'UNAVAILABLE');
    assert.strictEqual(getRes.externalDraftConflictRisk, true);
  });

  // ==========================================
  // P1-2: BROWSER DRAFT SAFETY
  // ==========================================
  await runTest('P1-2: Continue requires acknowledgeUnobservedBrowserDraft', async () => {
    await assert.rejects(
      async () => handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/astor-tuneup',
        mutation: {
          type: 'append_notebook_cells',
          cells: [{ cellType: 'code', source: 'print(1)' }]
        }
      }, submitAuth),
      /KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE/
    );
  });

  // ==========================================
  // P1-3: VERSION NUMBER PERSISTENCE
  // ==========================================
  await runTest('P1-3: Version number returned on continue and restore', async () => {
    const res = await handlers.handleKaggleProjectContinue({
      kernelRef: 'testuser/astor-tuneup',
      acknowledgeUnobservedBrowserDraft: true,
      mutation: {
        type: 'append_notebook_cells',
        cells: [{ cellType: 'code', source: 'print("Version check")' }]
      }
    }, submitAuth);
    assert.strictEqual(res.createsNewKaggleVersion, true);
    assert.notStrictEqual(res.createdVersionNumber, undefined);
  });

  // ==========================================
  // P2: RESTORE DRY-RUN UX
  // ==========================================
  await runTest('P2: Restore dryRun performs 0 mutations and returns validation report', async () => {
    const validNb = JSON.stringify({
      cells: [{ cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['print("Dry run master")\n'] }],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    });
    const dryRes = await handlers.handleKaggleProjectRestore({
      kernelRef: 'testuser/astor-tuneup',
      source: validNb,
      sourceSha256: crypto.createHash('sha256').update(validNb).digest('hex'),
      kernelType: 'notebook',
      dryRun: true,
      reason: 'Dry run restore validation'
    }, submitAuth);

    assert.strictEqual(dryRes.dryRun, true);
    assert.strictEqual(dryRes.sourceValidation, 'VALID');
    assert.strictEqual(dryRes.writeAllowed, true);
    assert.strictEqual(dryRes.targetKernelType, 'notebook');
    assert.strictEqual(typeof dryRes.currentProjectFingerprint, 'string');
    assert.strictEqual(dryRes.privacyValidation.privacyKnown, true);
  });

  // ==========================================
  // KAGGLE_PROJECT_RESTORE ACKNOWLEDGEMENT & SAFETY SUITE
  // ==========================================
  const validRestoreNb = JSON.stringify({
    cells: [{ cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['print("Restore payload")\n'] }],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5
  });
  const validRestoreSha = crypto.createHash('sha256').update(validRestoreNb).digest('hex');

  // TEST 1 — omitted acknowledgement / risk exists
  await runTest('Restore Test 1: Omitted acknowledgeUnobservedBrowserDraft is rejected with 0 pushes', async () => {
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/astor-tuneup' }; }
    };
    const tBackend = new KaggleBackend(taskStore, artifactStore, testKClient);
    const tHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: tBackend });

    await assert.rejects(
      async () => tHandlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        source: validRestoreNb,
        sourceSha256: validRestoreSha,
        kernelType: 'notebook',
        reason: 'Restore without ack'
      }, submitAuth),
      (err: any) => {
        const str = err.message || '';
        return str.includes('KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE');
      }
    );
    assert.strictEqual(pushCount, 0, 'No Kaggle push occurred');
  });

  // TEST 2 — false acknowledgement
  await runTest('Restore Test 2: Explicit acknowledgeUnobservedBrowserDraft=false is rejected with 0 pushes', async () => {
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/astor-tuneup' }; }
    };
    const tBackend = new KaggleBackend(taskStore, artifactStore, testKClient);
    const tHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: tBackend });

    await assert.rejects(
      async () => tHandlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        source: validRestoreNb,
        sourceSha256: validRestoreSha,
        kernelType: 'notebook',
        acknowledgeUnobservedBrowserDraft: false,
        reason: 'Restore with false ack'
      }, submitAuth),
      (err: any) => {
        const str = err.message || '';
        return str.includes('KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE');
      }
    );
    assert.strictEqual(pushCount, 0, 'No Kaggle push occurred');
  });

  // TEST 3 — true acknowledgement
  await runTest('Restore Test 3: Explicit acknowledgeUnobservedBrowserDraft=true allows restore to proceed', async () => {
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/astor-tuneup', versionNumber: 1 }; }
    };
    const tBackend = new KaggleBackend(taskStore, artifactStore, testKClient);
    const tHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: tBackend });

    const res = await tHandlers.handleKaggleProjectRestore({
      kernelRef: 'testuser/astor-tuneup',
      source: validRestoreNb,
      sourceSha256: validRestoreSha,
      kernelType: 'notebook',
      acknowledgeUnobservedBrowserDraft: true,
      reason: 'Explicitly authorized restore'
    }, submitAuth);

    assert.strictEqual(res.status, 'running');
    assert.strictEqual(res.createsNewKaggleVersion, true);
    assert.strictEqual(res.restoredSourceSha256, validRestoreSha);
  });

  // TEST 4 — acknowledgement cannot bypass fingerprint
  await runTest('Restore Test 4: ACK=true cannot bypass stale expectedCurrentFingerprint', async () => {
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/astor-tuneup' }; }
    };
    const tBackend = new KaggleBackend(taskStore, artifactStore, testKClient);
    const tHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: tBackend });

    await assert.rejects(
      async () => tHandlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        expectedCurrentFingerprint: 'invalid-stale-fingerprint-12345',
        source: validRestoreNb,
        sourceSha256: validRestoreSha,
        kernelType: 'notebook',
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Attempting conflict bypass'
      }, submitAuth),
      (err: any) => {
        const str = err.message || '';
        return str.includes('KAGGLE_PROJECT_CONFLICT');
      }
    );
    assert.strictEqual(pushCount, 0, 'No Kaggle push occurred');
  });

  // TEST 5 — acknowledgement cannot bypass source SHA
  await runTest('Restore Test 5: ACK=true cannot bypass sourceSha256 integrity guard', async () => {
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'testuser/astor-tuneup' }; }
    };
    const tBackend = new KaggleBackend(taskStore, artifactStore, testKClient);
    const tHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: tBackend });

    await assert.rejects(
      async () => tHandlers.handleKaggleProjectRestore({
        kernelRef: 'testuser/astor-tuneup',
        source: validRestoreNb,
        sourceSha256: 'deadbeef00000000000000000000000000000000000000000000000000000000',
        kernelType: 'notebook',
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Attempting SHA bypass'
      }, submitAuth),
      (err: any) => {
        const str = err.message || '';
        return str.includes('RECOVERY_MASTER_SHA_MISMATCH');
      }
    );
    assert.strictEqual(pushCount, 0, 'No Kaggle push occurred');
  });

  // TEST 6 — acknowledgement cannot bypass ownership
  await runTest('Restore Test 6: ACK=true cannot bypass foreign project ownership guard', async () => {
    let pushCount = 0;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async () => { pushCount++; return { success: true, kernelSlug: 'otheruser/foreign-kernel' }; }
    };
    const tBackend = new KaggleBackend(taskStore, artifactStore, testKClient);
    const tHandlers = new McpHandlers({ ...gatewayFacade, kaggleBackend: tBackend });

    await assert.rejects(
      async () => tHandlers.handleKaggleProjectRestore({
        kernelRef: 'otheruser/foreign-kernel',
        source: validRestoreNb,
        sourceSha256: validRestoreSha,
        kernelType: 'notebook',
        acknowledgeUnobservedBrowserDraft: true,
        reason: 'Attempting ownership bypass'
      }, submitAuth),
      (err: any) => {
        const str = err.message || '';
        return str.includes('KAGGLE_PROJECT_WRITE_FORBIDDEN');
      }
    );
    assert.strictEqual(pushCount, 0, 'No Kaggle push occurred');
  });

  // TEST 7 — ACK not forwarded to durable task payload or Kaggle API
  await runTest('Restore Test 7: acknowledgeUnobservedBrowserDraft is NOT forwarded to Kaggle task payload', async () => {
    let capturedPayload: any = null;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: true, enableInternet: true },
        source: validRestoreNb
      }),
      pushKernel: async (payloadOrDir: any, maybePayload?: any) => {
        capturedPayload = maybePayload || payloadOrDir;
        return { success: true, kernelSlug: 'testuser/astor-tuneup', versionNumber: 1 };
      }
    };
    const tStore = new TaskStore();
    const tBackend = new KaggleBackend(tStore, artifactStore, testKClient);
    const tRouter = new TaskRouter(
      tStore,
      idempotencyStore,
      tBackend,
      { dispatchTask: () => ({ taskId: 's1' }), listWorkers: () => [] } as any,
      killSwitch,
      auditLogger
    );
    const tHandlers = new McpHandlers({ ...gatewayFacade, taskRouter: tRouter, taskStore: tStore, kaggleBackend: tBackend });

    const res = await tHandlers.handleKaggleProjectRestore({
      kernelRef: 'testuser/astor-tuneup',
      source: validRestoreNb,
      sourceSha256: validRestoreSha,
      kernelType: 'notebook',
      acknowledgeUnobservedBrowserDraft: true,
      reason: 'Strip test'
    }, submitAuth);

    const task = tStore.getTask(res.taskId);
    assert.strictEqual(task?.payload?.acknowledgeUnobservedBrowserDraft, undefined, 'Task payload must not have ack field');
    assert.strictEqual(capturedPayload?.acknowledgeUnobservedBrowserDraft, undefined, 'Kaggle outgoing payload must not have ack field');
  });

  // TEST 8 — metadata preservation with ACK
  await runTest('Restore Test 8: Metadata (machineShape, GPU, Internet, datasets) properly propagates with ACK', async () => {
    let capturedPayload: any = null;
    const testKClient: any = {
      getUsername: () => 'testuser',
      pullProject: async () => ({
        metadata: { kernelType: 'notebook', language: 'python', isPrivate: true, enableGpu: false, enableInternet: false },
        source: validRestoreNb
      }),
      pushKernel: async (payloadOrDir: any, maybePayload?: any) => {
        capturedPayload = maybePayload || payloadOrDir;
        return { success: true, kernelSlug: 'testuser/astor-tuneup', versionNumber: 1 };
      }
    };
    const tStore = new TaskStore();
    const tBackend = new KaggleBackend(tStore, artifactStore, testKClient);
    const tRouter = new TaskRouter(
      tStore,
      idempotencyStore,
      tBackend,
      { dispatchTask: () => ({ taskId: 's1' }), listWorkers: () => [] } as any,
      killSwitch,
      auditLogger
    );
    const tHandlers = new McpHandlers({ ...gatewayFacade, taskRouter: tRouter, taskStore: tStore, kaggleBackend: tBackend });

    const targetDatasets = [
      'astorhsu/astor-tuneup-project',
      'astorhsu/astor-gate2c-9a-miningpool-kaggle-package'
    ];
    const res = await tHandlers.handleKaggleProjectRestore({
      kernelRef: 'testuser/astor-tuneup',
      source: validRestoreNb,
      sourceSha256: validRestoreSha,
      kernelType: 'notebook',
      machineShape: 'NvidiaTeslaT4',
      enableGpu: true,
      enableInternet: true,
      datasetDataSources: targetDatasets,
      acknowledgeUnobservedBrowserDraft: true,
      reason: 'Update hardware and datasets'
    }, submitAuth);

    const task = tStore.getTask(res.taskId);
    assert.strictEqual(task?.payload?.machineShape, 'NvidiaTeslaT4');
    assert.strictEqual(task?.payload?.enableGpu, true);
    assert.strictEqual(task?.payload?.enableInternet, true);
    assert.deepStrictEqual(task?.payload?.datasetDataSources, targetDatasets);
  });

  // TEST 9 — canonical MCP schema exposure
  await runTest('Restore Test 9: getCanonicalToolsList() exposes acknowledgeUnobservedBrowserDraft for kaggle_project_restore', () => {
    const tools = getCanonicalToolsList();
    const restoreTool = tools.find(t => t.name === 'kaggle_project_restore');
    assert.ok(restoreTool, 'kaggle_project_restore tool must exist');

    const schema = restoreTool.inputSchema as any;
    assert.ok(schema.properties.acknowledgeUnobservedBrowserDraft, 'acknowledgeUnobservedBrowserDraft property must exist in inputSchema');
    assert.strictEqual(schema.properties.acknowledgeUnobservedBrowserDraft.type, 'boolean');
    assert.strictEqual(schema.additionalProperties, false);
    assert.ok(!schema.required.includes('acknowledgeUnobservedBrowserDraft'), 'acknowledgeUnobservedBrowserDraft must NOT be required');
  });

  // TEST 10 — KAGGLE_PROJECT_RESTORE_SCHEMA direct definition
  await runTest('Restore Test 10: KAGGLE_PROJECT_RESTORE_SCHEMA defines optional acknowledgeUnobservedBrowserDraft', () => {
    const schema = KAGGLE_PROJECT_RESTORE_SCHEMA as any;
    assert.strictEqual(schema.type, 'object');
    assert.strictEqual(schema.properties.acknowledgeUnobservedBrowserDraft.type, 'boolean');
    assert.ok(!schema.required.includes('acknowledgeUnobservedBrowserDraft'));
    assert.strictEqual(schema.additionalProperties, false);
  });

  return { passed, failed };
}

