import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { TaskStore } from '../../src/storage/task-store';
import { ArtifactStore } from '../../src/storage/artifact-store';
import { IdempotencyStore } from '../../src/storage/idempotency-store';
import { KaggleBackend } from '../../src/kaggle/backend';
import { TaskRouter } from '../../src/gateway/task-router';
import { McpHandlers } from '../../src/mcp/handlers';
import { KillSwitch } from '../../src/security/kill-switch';
import {
  computeWorkspaceFingerprint,
  validateProjectManifest,
  validateWorkspaceRelativePath,
  buildKaggleUploadTree,
  DevSpaceProjectManifest,
  DevSpaceExecutionResult
} from '../../src/kaggle/workspace-manager';

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

  // Setup mock dataset for testing
  const initialManifest: DevSpaceProjectManifest = {
    name: 'Astor TuneUp',
    slug: 'astor-tuneup-project',
    owner: 'testuser',
    version: 1,
    type: 'workspace',
    entrypoint: 'experiments/gate2c_9a_mining.py',
    runnerKernelRef: 'testuser/astor-tuneup-thin-runner',
    archiveMaster: {
      filename: 'archive/astor-tuneup-original.ipynb',
      size: 14276636,
      sha256: '9fb3664e184f0536f2fbbc31d53007c8eaa630c8391019934c3de015fc632450',
      cellCount: 139
    },
    files: {
      'devspace-project.json': { size: 1024, sha256: 'sha-manifest-v1' },
      'PROJECT_CONTEXT.md': { size: 30, sha256: crypto.createHash('sha256').update('# Astor TuneUp Context Header\n').digest('hex') },
      'src/astor_tuneup/config.py': { size: 45, sha256: crypto.createHash('sha256').update('import os\nPROJECT_NAME = "Astor TuneUp"\n').digest('hex') },
      'src/astor_tuneup/__init__.py': { size: 25, sha256: crypto.createHash('sha256').update('"""Astor TuneUp init"""\n').digest('hex') },
      'experiments/gate2c_9a_mining.py': { size: 50, sha256: crypto.createHash('sha256').update('print("Gate2C-9A failure mining entrypoint")\n').digest('hex') }
    }
  };

  const initialFiles: Record<string, string> = {
    'devspace-project.json': JSON.stringify(initialManifest, null, 2),
    'PROJECT_CONTEXT.md': '# Astor TuneUp Context Header\n',
    'src/astor_tuneup/config.py': 'import os\nPROJECT_NAME = "Astor TuneUp"\n',
    'src/astor_tuneup/__init__.py': '"""Astor TuneUp init"""\n',
    'experiments/gate2c_9a_mining.py': 'print("Gate2C-9A failure mining entrypoint")\n'
  };

  client.registerMockDataset('testuser', 'astor-tuneup-project', 1, initialFiles, {
    title: 'Astor TuneUp Project',
    currentVersionNumber: 1
  });

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

  await runTest('validateWorkspaceRelativePath enforces safe POSIX relative paths', () => {
    assert.strictEqual(validateWorkspaceRelativePath('src/pkg/a.py'), 'src/pkg/a.py');
    assert.strictEqual(validateWorkspaceRelativePath('config.json'), 'config.json');

    assert.throws(() => validateWorkspaceRelativePath('/abs/path.py'), /INVALID_WORKSPACE_PATH/);
    assert.throws(() => validateWorkspaceRelativePath('src\\pkg\\a.py'), /INVALID_WORKSPACE_PATH/);
    assert.throws(() => validateWorkspaceRelativePath('../outside.py'), /INVALID_WORKSPACE_PATH/);
    assert.throws(() => validateWorkspaceRelativePath('src/../a.py'), /INVALID_WORKSPACE_PATH/);
    assert.throws(() => validateWorkspaceRelativePath(''), /INVALID_WORKSPACE_PATH/);
  });

  await runTest('buildKaggleUploadTree constructs hierarchical directory tree for Kaggle API', () => {
    const entries = [
      { relPath: 'devspace-project.json', token: 't1' },
      { relPath: 'src/pkg/a.py', token: 't2' },
      { relPath: 'src/pkg/b.py', token: 't3' },
      { relPath: 'config/test.json', token: 't4' }
    ];
    const tree = buildKaggleUploadTree(entries);
    assert.strictEqual(tree.files.length, 1);
    assert.strictEqual(tree.files[0].description, 'devspace-project.json');
    assert.strictEqual(tree.directories.length, 2);
    const srcDir = tree.directories.find(d => d.name === 'src');
    assert.ok(srcDir);
    assert.strictEqual(srcDir.directories.length, 1);
    assert.strictEqual(srcDir.directories[0].name, 'pkg');
    assert.strictEqual(srcDir.directories[0].files.length, 2);
  });

  await runTest('kaggle_workspace_get returns real dataset-backed manifest, outline and fingerprint', async () => {
    const res = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    assert.strictEqual(res.name, 'Astor TuneUp');
    assert.strictEqual(res.datasetVersion, 1);
    assert.strictEqual(res.manifestVersion, 1);
    assert.ok(res.workspaceFingerprint);
    assert.ok(res.archiveMaster);
    assert.strictEqual(res.archiveMaster.cellCount, 139);
    assert.strictEqual(res.archiveMaster.sha256, '9fb3664e184f0536f2fbbc31d53007c8eaa630c8391019934c3de015fc632450');
    assert.strictEqual(res.files.length, 5);
  });

  await runTest('kaggle_workspace_file retrieves file content and validates SHA-256 and size', async () => {
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
    assert.strictEqual(fileRes.hasMore, false);
  });

  await runTest('listDatasetFiles paginates >100 files across multiple pages seamlessly', async () => {
    const manyFiles: Record<string, string> = {
      'devspace-project.json': JSON.stringify(initialManifest, null, 2)
    };
    for (let i = 1; i <= 150; i++) {
      manyFiles[`src/mod/file_${i}.py`] = `print("file ${i}")\n`;
    }
    client.registerMockDataset('testuser', 'many-files-project', 1, manyFiles);

    const res = await client.listDatasetFiles('testuser', 'many-files-project', 1);
    assert.strictEqual(res.datasetFiles.length, 151);
  });

  await runTest('loadWorkspaceRevision fails closed on manifest version mismatch', async () => {
    const corruptManifest = { ...initialManifest, version: 99 };
    const corruptFiles = {
      ...initialFiles,
      'devspace-project.json': JSON.stringify(corruptManifest, null, 2)
    };
    client.registerMockDataset('testuser', 'mismatch-project', 1, corruptFiles);

    let errCaught = false;
    try {
      await handlers.loadWorkspaceRevision('testuser', 'mismatch-project');
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_WORKSPACE_MANIFEST_VERSION_MISMATCH'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_WORKSPACE_MANIFEST_VERSION_MISMATCH');
  });

  await runTest('loadWorkspaceRevision fails closed on manifest file missing from dataset', async () => {
    const corruptManifest: DevSpaceProjectManifest = {
      ...initialManifest,
      slug: 'missing-file-project',
      files: {
        ...initialManifest.files,
        'missing_file.py': { size: 100, sha256: 'dummy' }
      }
    };
    const corruptFiles = {
      ...initialFiles,
      'devspace-project.json': JSON.stringify(corruptManifest, null, 2)
    };
    client.registerMockDataset('testuser', 'missing-file-project', 1, corruptFiles);

    let errCaught = false;
    try {
      await handlers.loadWorkspaceRevision('testuser', 'missing-file-project');
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_WORKSPACE_FILE_MISSING'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_WORKSPACE_FILE_MISSING');
  });

  await runTest('kaggle_workspace_file fails closed on file SHA-256 tampering', async () => {
    const tamperedManifest: DevSpaceProjectManifest = {
      ...initialManifest,
      slug: 'tampered-project'
    };
    const tamperedFiles = {
      ...initialFiles,
      'devspace-project.json': JSON.stringify(tamperedManifest, null, 2),
      'PROJECT_CONTEXT.md': '# TAMPERED MALICIOUS CONTENT\n'
    };
    client.registerMockDataset('testuser', 'tampered-project', 1, tamperedFiles);

    let errCaught = false;
    try {
      await handlers.handleKaggleWorkspaceFile({
        project: 'testuser/tampered-project',
        path: 'PROJECT_CONTEXT.md'
      }, readCaller);
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('KAGGLE_WORKSPACE_FILE_HASH_MISMATCH'));
    }
    assert.ok(errCaught, 'Expected KAGGLE_WORKSPACE_FILE_HASH_MISMATCH');
  });

  await runTest('kaggle_workspace_continue executes canonical runner, preserving runner source code & SHA', async () => {
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
    assert.ok(continueRes.runnerSourceShaBefore);
    assert.ok(continueRes.runnerSourceShaAfter);
    assert.strictEqual(continueRes.runnerSourceShaBefore, continueRes.runnerSourceShaAfter);

    // Verify read-back on Version 2 preserves unchanged files
    const v2Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    assert.strictEqual(v2Get.datasetVersion, 2);
    assert.strictEqual(v2Get.manifestVersion, 2);
    const v2FilePaths = v2Get.files.map((f: any) => f.path);
    assert.ok(v2FilePaths.includes('PROJECT_CONTEXT.md'), 'PROJECT_CONTEXT.md must be preserved in Version 2');
    assert.ok(v2FilePaths.includes('experiments/gate2c_9a_mining.py'), 'experiments/gate2c_9a_mining.py must be preserved in Version 2');
  });

  await runTest('loadWorkspaceRevision correctly classifies exact vs flattened physical storage layout', async () => {
    const mixedManifest: DevSpaceProjectManifest = {
      name: 'Mixed Project',
      slug: 'mixed-project',
      owner: 'testuser',
      version: 2,
      type: 'workspace',
      entrypoint: 'src/main.py',
      runnerKernelRef: 'testuser/runner',
      files: {
        'src/main.py': { size: 20, sha256: crypto.createHash('sha256').update('print("main")\n').digest('hex') },
        'PROJECT_CONTEXT.md': { size: 10, sha256: crypto.createHash('sha256').update('# context\n').digest('hex') }
      }
    };

    // Stored with flattened physical path for src/main.py and exact for PROJECT_CONTEXT.md
    const physicalFiles: Record<string, string> = {
      'devspace-project.json': JSON.stringify(mixedManifest, null, 2),
      'src_main.py': 'print("main")\n',
      'PROJECT_CONTEXT.md': '# context\n'
    };

    client.registerMockDataset('testuser', 'mixed-project', 2, physicalFiles, {
      title: 'Mixed Project',
      currentVersionNumber: 2
    });

    const ws = await handlers.loadWorkspaceRevision('testuser', 'mixed-project');
    assert.strictEqual(ws.resolvedStorage.get('src/main.py')?.storageLayout, 'flattened');
    assert.strictEqual(ws.resolvedStorage.get('src/main.py')?.storagePath, 'src_main.py');
    assert.strictEqual(ws.resolvedStorage.get('PROJECT_CONTEXT.md')?.storageLayout, 'exact');
    assert.strictEqual(ws.resolvedStorage.get('PROJECT_CONTEXT.md')?.storagePath, 'PROJECT_CONTEXT.md');
  });

  await runTest('kaggle_workspace_continue migrates flattened Version 2 dataset to exact hierarchical Version 3 dataset', async () => {
    const v2Manifest: DevSpaceProjectManifest = {
      name: 'Migration Fixture',
      slug: 'migration-fixture',
      owner: 'testuser',
      version: 2,
      type: 'workspace',
      entrypoint: 'src/pkg/entry.py',
      runnerKernelRef: 'testuser/runner',
      files: {
        'src/pkg/entry.py': { size: Buffer.byteLength('print("entry V2")\n'), sha256: crypto.createHash('sha256').update('print("entry V2")\n').digest('hex') },
        'config/app.json': { size: Buffer.byteLength('{"env":"v2"}\n'), sha256: crypto.createHash('sha256').update('{"env":"v2"}\n').digest('hex') },
        'PROJECT_CONTEXT.md': { size: Buffer.byteLength('# context\n'), sha256: crypto.createHash('sha256').update('# context\n').digest('hex') }
      }
    };

    // Flattened physical files on Kaggle for Version 2 (matching Astor V2 condition)
    const v2PhysicalFiles: Record<string, string> = {
      'devspace-project.json': JSON.stringify(v2Manifest, null, 2),
      'src_pkg_entry.py': 'print("entry V2")\n',
      'config_app.json': '{"env":"v2"}\n',
      'PROJECT_CONTEXT.md': '# context\n'
    };

    client.registerMockDataset('testuser', 'migration-fixture', 2, v2PhysicalFiles, {
      title: 'Migration Fixture',
      currentVersionNumber: 2
    });

    const v2Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/migration-fixture' }, adminCaller);
    const fpV2 = v2Get.workspaceFingerprint;

    // Mutate only src/pkg/entry.py; leave config/app.json and PROJECT_CONTEXT.md unchanged
    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/migration-fixture',
      expectedWorkspaceFingerprint: fpV2,
      changes: [{ path: 'src/pkg/entry.py', content: 'print("entry V3 migrated!")\n' }],
      reason: 'Migrate to canonical hierarchical V3'
    }, adminCaller);

    assert.strictEqual(continueRes.workspaceVersion, 3);

    // Read back Version 3: all files must now have exact storageLayout and zero flattened files
    const v3Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/migration-fixture' }, adminCaller);
    assert.strictEqual(v3Get.datasetVersion, 3);
    assert.strictEqual(v3Get.manifestVersion, 3);

    for (const f of v3Get.files) {
      assert.strictEqual(f.storageLayout, 'exact', `File ${f.path} must have exact storageLayout in V3`);
      assert.strictEqual(f.storagePath, f.path, `File ${f.path} storagePath must equal logical path`);
    }

    // Verify unchanged config/app.json preserved exact SHA
    const configV3 = await handlers.handleKaggleWorkspaceFile({
      project: 'testuser/migration-fixture',
      path: 'config/app.json'
    }, readCaller);
    assert.strictEqual(configV3.sha256, v2Manifest.files['config/app.json'].sha256);
    assert.strictEqual(configV3.storageLayout, 'exact');
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

  // ============================================================================
  // additionalDatasetDataSources Integration & Validation Tests
  // ============================================================================

  await runTest('kaggle_workspace_continue without additionalDatasetDataSources preserves existing sources and returns runnerDatasetSources', async () => {
    const v2Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV2 = v2Get.workspaceFingerprint;

    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/astor-tuneup-project',
      expectedWorkspaceFingerprint: fpV2,
      changes: [{ path: 'src/astor_tuneup/config.py', content: 'import os\n# V3 change\n' }],
      reason: 'Standard workspace continue without additional datasets'
    }, adminCaller);

    assert.strictEqual(continueRes.workspaceVersion, 3);
    assert.ok(Array.isArray(continueRes.runnerDatasetSources), 'runnerDatasetSources must be returned in response');
    assert.ok(continueRes.runnerDatasetSources.includes('testuser/astor-tuneup-project'), 'Workspace dataset must be in runner sources');
    assert.strictEqual(continueRes.runnerSourceShaBefore, continueRes.runnerSourceShaAfter);
  });

  await runTest('kaggle_workspace_continue with single additionalDatasetDataSources mounts existing, workspace, and additional dataset', async () => {
    const v3Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV3 = v3Get.workspaceFingerprint;

    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/astor-tuneup-project',
      expectedWorkspaceFingerprint: fpV3,
      changes: [{ path: 'src/astor_tuneup/config.py', content: 'import os\n# V4 change\n' }],
      additionalDatasetDataSources: ['astorhsu/astor-gate2c-9a-miningpool-kaggle-package'],
      reason: 'Mount miningpool dataset for gate2c runner execution'
    }, adminCaller);

    assert.strictEqual(continueRes.workspaceVersion, 4);
    assert.ok(continueRes.runnerDatasetSources.includes('testuser/astor-tuneup-project'), 'Workspace dataset must be present');
    assert.ok(continueRes.runnerDatasetSources.includes('astorhsu/astor-gate2c-9a-miningpool-kaggle-package'), 'Additional dataset must be present');
    assert.strictEqual(continueRes.runnerSourceShaBefore, continueRes.runnerSourceShaAfter, 'Runner source code must remain unmodified');
  });

  await runTest('kaggle_workspace_continue deduplicates duplicate additionalDatasetDataSources', async () => {
    const v4Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV4 = v4Get.workspaceFingerprint;

    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/astor-tuneup-project',
      expectedWorkspaceFingerprint: fpV4,
      changes: [{ path: 'src/astor_tuneup/config.py', content: 'import os\n# V5 change\n' }],
      additionalDatasetDataSources: [
        'astorhsu/astor-gate2c-9a-miningpool-kaggle-package',
        'astorhsu/astor-gate2c-9a-miningpool-kaggle-package',
        'astorhsu/astor-gate2c-9a-miningpool-kaggle-package'
      ],
      reason: 'Deduplicate duplicate datasets'
    }, adminCaller);

    assert.strictEqual(continueRes.workspaceVersion, 5);
    const occurrences = continueRes.runnerDatasetSources.filter((s: string) => s === 'astorhsu/astor-gate2c-9a-miningpool-kaggle-package').length;
    assert.strictEqual(occurrences, 1, 'Duplicate additional dataset must appear exactly once');
  });

  await runTest('kaggle_workspace_continue deduplicates additional dataset identical to workspace dataset', async () => {
    const v5Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV5 = v5Get.workspaceFingerprint;

    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/astor-tuneup-project',
      expectedWorkspaceFingerprint: fpV5,
      changes: [{ path: 'src/astor_tuneup/config.py', content: 'import os\n# V6 change\n' }],
      additionalDatasetDataSources: ['testuser/astor-tuneup-project'],
      reason: 'Additional dataset is same as workspace'
    }, adminCaller);

    assert.strictEqual(continueRes.workspaceVersion, 6);
    const occurrences = continueRes.runnerDatasetSources.filter((s: string) => s === 'testuser/astor-tuneup-project').length;
    assert.strictEqual(occurrences, 1, 'Workspace dataset must appear exactly once');
  });

  await runTest('kaggle_workspace_continue rejects invalid additional dataset refs before mutation', async () => {
    const v6Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV6 = v6Get.workspaceFingerprint;

    const invalidTestCases = [
      'foo',
      '/owner/dataset',
      'owner/dataset/extra',
      'owner\\dataset',
      '',
      '   ',
      'owner/..',
      '../slug'
    ];

    for (const invalidRef of invalidTestCases) {
      let errCaught = false;
      try {
        await handlers.handleKaggleWorkspaceContinue({
          project: 'testuser/astor-tuneup-project',
          expectedWorkspaceFingerprint: fpV6,
          changes: [{ path: 'src/astor_tuneup/config.py', content: 'import os\n# invalid test\n' }],
          additionalDatasetDataSources: [invalidRef],
          reason: 'Invalid ref test'
        }, adminCaller);
      } catch (err: any) {
        errCaught = true;
        assert.ok(err.message.includes('INVALID_ADDITIONAL_DATASET_SOURCE'), `Expected INVALID_ADDITIONAL_DATASET_SOURCE for "${invalidRef}", got: ${err.message}`);
      }
      assert.ok(errCaught, `Should reject invalid ref "${invalidRef}"`);
    }

    // Verify no mutation occurred (version remains 6)
    const checkGet = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    assert.strictEqual(checkGet.datasetVersion, 6, 'Workspace version must not increment on validation failure');
  });

  await runTest('kaggle_workspace_continue rejects exceeding maximum allowed additional dataset refs (>8)', async () => {
    const v6Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV6 = v6Get.workspaceFingerprint;

    const nineRefs = Array.from({ length: 9 }, (_, i) => `owner/dataset-${i + 1}`);

    let errCaught = false;
    try {
      await handlers.handleKaggleWorkspaceContinue({
        project: 'testuser/astor-tuneup-project',
        expectedWorkspaceFingerprint: fpV6,
        changes: [{ path: 'src/astor_tuneup/config.py', content: 'import os\n# max test\n' }],
        additionalDatasetDataSources: nineRefs,
        reason: 'Too many datasets'
      }, adminCaller);
    } catch (err: any) {
      errCaught = true;
      assert.ok(err.message.includes('INVALID_ADDITIONAL_DATASET_SOURCE'));
    }
    assert.ok(errCaught, 'Should reject >8 additional dataset refs');
  });

  await runTest('representative Astor workspace continue mounts workspace and gate2c miningpool dataset', async () => {
    const v6Get = await handlers.handleKaggleWorkspaceGet({ project: 'testuser/astor-tuneup-project' }, adminCaller);
    const fpV6 = v6Get.workspaceFingerprint;

    const continueRes = await handlers.handleKaggleWorkspaceContinue({
      project: 'testuser/astor-tuneup-project',
      expectedWorkspaceFingerprint: fpV6,
      changes: [{ path: 'experiments/gate2c_9a_mining.py', content: 'print("Representative Astor V11 mining call test")\n' }],
      additionalDatasetDataSources: ['astorhsu/astor-gate2c-9a-miningpool-kaggle-package'],
      reason: 'Representative Astor Gate2C 9A mining run'
    }, adminCaller);

    assert.strictEqual(continueRes.workspaceVersion, 7);
    assert.ok(continueRes.runnerDatasetSources.includes('testuser/astor-tuneup-project'));
    assert.ok(continueRes.runnerDatasetSources.includes('astorhsu/astor-gate2c-9a-miningpool-kaggle-package'));
    assert.strictEqual(continueRes.runnerSourceShaBefore, continueRes.runnerSourceShaAfter);
  });

  await runTest('pre-rejects oversized kernel source (>1MB) in kaggle_project_continue and recommends workspace mode', async () => {
    const giantNb = JSON.stringify({
      cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['# giant\n' + 'x = 1\n'.repeat(150000)] }],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5
    });

    let errCaught = false;
    try {
      await handlers.handleKaggleProjectContinue({
        kernelRef: 'testuser/mock-notebook',
        expectedCurrentFingerprint: 'dummy',
        acknowledgeUnobservedBrowserDraft: true,
        mutation: {
          type: 'replace_source',
          source: giantNb
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
        allowKernelTypeChange: true,
        kernelTypeChangeReason: 'Authorized oversized test',
        acknowledgeUnobservedBrowserDraft: true,
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

  await runTest('DevSpaceExecutionResult schema validates separation of workspaceValidation and experimentExecution', () => {
    const passResult: DevSpaceExecutionResult = {
      project: 'Astor TuneUp',
      datasetVersion: 2,
      workspaceFingerprint: '4babc98925be4547fad439062bd713ef9e289a88fce300ff208c2922a978804b',
      entrypoint: 'experiments/gate2c_9a_mining.py',
      workspaceValidation: 'PASS',
      experimentExecution: 'PASS'
    };

    const expFailResult: DevSpaceExecutionResult = {
      project: 'Astor TuneUp',
      datasetVersion: 2,
      workspaceFingerprint: '4babc98925be4547fad439062bd713ef9e289a88fce300ff208c2922a978804b',
      entrypoint: 'experiments/gate2c_9a_mining.py',
      workspaceValidation: 'PASS',
      experimentExecution: 'FAIL',
      error: 'Simulated detector failure mining test exception'
    };

    assert.strictEqual(passResult.workspaceValidation, 'PASS');
    assert.strictEqual(passResult.experimentExecution, 'PASS');
    assert.strictEqual(expFailResult.workspaceValidation, 'PASS');
    assert.strictEqual(expFailResult.experimentExecution, 'FAIL');
  });

  // ============================================================================
  // Canonical Workspace Thin Runner Template Tests (Python Runtime)
  // ============================================================================
  const templatePath = path.resolve(__dirname, '../../src/kaggle/canonical-runner-template.py');

  function runPythonRunner(inputDir: string, workDir: string): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync('python', [templatePath], {
      env: {
        ...process.env,
        DEVSPACE_INPUT_ROOT: inputDir,
        DEVSPACE_WORK_ROOT: workDir
      },
      encoding: 'utf-8'
    });
    return {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || ''
    };
  }

  await runTest('canonical runner fails closed when devspace-execution-context.json is missing', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-1-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-1-'));
    try {
      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_EXECUTION_CONTEXT_MISSING'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner fails closed on malformed devspace-execution-context.json', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-2-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-2-'));
    try {
      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), '{ invalid json ...', 'utf-8');
      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_EXECUTION_CONTEXT_MALFORMED'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner fails closed on execution context with missing required fields', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-3-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-3-'));
    try {
      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({ project: 'test' }), 'utf-8');
      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_EXECUTION_CONTEXT_INVALID'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner fails closed when no workspace matches context slug', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-4-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-4-'));
    try {
      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({
        project: 'Target Project',
        slug: 'target-slug',
        expectedDatasetVersion: 2,
        expectedWorkspaceFingerprint: 'dummy-fp',
        entrypoint: 'src/main.py'
      }), 'utf-8');
      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_WORKSPACE_NOT_FOUND'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner fails closed on multiple ambiguous matching workspaces', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-5-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-5-'));
    try {
      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({
        project: 'Target Project',
        slug: 'target-slug',
        expectedDatasetVersion: 2,
        expectedWorkspaceFingerprint: 'dummy-fp',
        entrypoint: 'src/main.py'
      }), 'utf-8');

      const ds1 = path.join(tmpInput, 'ds1');
      const ds2 = path.join(tmpInput, 'ds2');
      fs.mkdirSync(ds1);
      fs.mkdirSync(ds2);
      fs.writeFileSync(path.join(ds1, 'devspace-project.json'), JSON.stringify({ slug: 'target-slug', name: 'Target Project' }), 'utf-8');
      fs.writeFileSync(path.join(ds2, 'devspace-project.json'), JSON.stringify({ slug: 'target-slug', name: 'Target Project' }), 'utf-8');

      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_WORKSPACE_AMBIGUOUS'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner rejects entrypoint mismatch between context and manifest', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-6-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-6-'));
    try {
      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({
        project: 'Target Project',
        slug: 'target-slug',
        expectedDatasetVersion: 2,
        expectedWorkspaceFingerprint: 'dummy-fp',
        entrypoint: 'src/entry_a.py'
      }), 'utf-8');

      fs.writeFileSync(path.join(tmpInput, 'devspace-project.json'), JSON.stringify({
        name: 'Target Project',
        slug: 'target-slug',
        version: 2,
        entrypoint: 'src/entry_b.py',
        files: {}
      }), 'utf-8');

      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_WORKSPACE_VERSION_MISMATCH'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner rejects version mismatch between context and manifest', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-7-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-7-'));
    try {
      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({
        project: 'Target Project',
        slug: 'target-slug',
        expectedDatasetVersion: 2,
        expectedWorkspaceFingerprint: 'dummy-fp',
        entrypoint: 'src/main.py'
      }), 'utf-8');

      fs.writeFileSync(path.join(tmpInput, 'devspace-project.json'), JSON.stringify({
        name: 'Target Project',
        slug: 'target-slug',
        version: 3, // actual is 3 vs expected 2
        entrypoint: 'src/main.py',
        files: {}
      }), 'utf-8');

      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_WORKSPACE_VERSION_MISMATCH'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner rejects fingerprint mismatch between context and runtime', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-8-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-8-'));
    try {
      const man = {
        name: 'Target Project',
        slug: 'target-slug',
        version: 2,
        entrypoint: 'src/main.py',
        runnerKernelRef: 'user/runner',
        files: { 'src/main.py': { size: 10, sha256: 'abc' } }
      };
      const realFp = computeWorkspaceFingerprint(man as any);

      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({
        project: 'Target Project',
        slug: 'target-slug',
        expectedDatasetVersion: 2,
        expectedWorkspaceFingerprint: 'wrong-stale-fingerprint',
        entrypoint: 'src/main.py'
      }), 'utf-8');

      fs.writeFileSync(path.join(tmpInput, 'devspace-project.json'), JSON.stringify(man), 'utf-8');

      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 1);
      assert.ok(res.stdout.includes('DEVSPACE_WORKSPACE_VERSION_MISMATCH'));
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  await runTest('canonical runner successfully executes entrypoint and writes devspace-result.json on valid context', () => {
    const tmpInput = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-test-9-'));
    const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu-runner-work-9-'));
    try {
      const entryCode = 'print("Running Valid Entrypoint!")\nx = 42\n';
      const entrySha = crypto.createHash('sha256').update(entryCode).digest('hex');
      const srcDir = path.join(tmpInput, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'main.py'), entryCode, 'utf-8');

      const man: DevSpaceProjectManifest = {
        name: 'Target Project',
        slug: 'target-slug',
        owner: 'testuser',
        version: 2,
        type: 'workspace',
        entrypoint: 'src/main.py',
        runnerKernelRef: 'testuser/runner',
        files: { 'src/main.py': { size: Buffer.byteLength(entryCode), sha256: entrySha } }
      };
      const realFp = computeWorkspaceFingerprint(man);

      fs.writeFileSync(path.join(tmpInput, 'devspace-execution-context.json'), JSON.stringify({
        project: 'Target Project',
        slug: 'target-slug',
        expectedDatasetVersion: 2,
        expectedWorkspaceFingerprint: realFp,
        entrypoint: 'src/main.py'
      }), 'utf-8');

      fs.writeFileSync(path.join(tmpInput, 'devspace-project.json'), JSON.stringify(man), 'utf-8');

      const res = runPythonRunner(tmpInput, tmpWork);
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('RUNTIME_WORKSPACE_IDENTITY_GUARD: PASS'));
      assert.ok(res.stdout.includes('Project Entrypoint Execution: SUCCESS'));
      assert.ok(res.stdout.includes('DEVSPACE_RUNNER_FINISH_PASS'));

      // Check devspace-result.json
      const resultPath = path.join(tmpWork, 'devspace-result.json');
      assert.ok(fs.existsSync(resultPath));
      const resData = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      assert.strictEqual(resData.project, 'Target Project');
      assert.strictEqual(resData.datasetVersion, 2);
      assert.strictEqual(resData.workspaceFingerprint, realFp);
      assert.strictEqual(resData.workspaceValidation, 'PASS');
      assert.strictEqual(resData.experimentExecution, 'PASS');
    } finally {
      fs.rmSync(tmpInput, { recursive: true, force: true });
      fs.rmSync(tmpWork, { recursive: true, force: true });
    }
  });

  return { passed, failed };
}

