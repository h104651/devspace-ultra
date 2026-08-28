import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { TaskExecutor } from '../../src/local-agent/task-executor';
import { ProjectRegistry } from '../../src/local-agent/project-registry';
import { McpHandlers, McpCallerContext } from '../../src/mcp/handlers';
import { GatewayServer } from '../../src/gateway/server';

export async function runLocalWorkspaceDiscoveryIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      failed++;
      console.error(`\n  FAIL: ${name}\n  ${err.stack || err.message}`);
    }
  }

  const tmpBase = path.join(os.tmpdir(), `devspace-discovery-e2e-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  // Create mock workspace hierarchy:
  // workspace-root (no .git at root)
  // ├── docs/
  // │   ├── PRD.md
  // │   └── architecture.txt
  // ├── mobile/
  // │   ├── .git/ (initialized real git repo for clean/dirty tests)
  // │   ├── pubspec.yaml
  // │   └── lib/
  // │       └── main.dart
  // ├── ai/
  // │   └── experiments/
  // │       ├── .git/ (mock .git folder with only HEAD)
  // │       ├── pyproject.toml
  // │       └── train.py
  // ├── backend/
  // │   ├── package.json
  // │   └── server.ts
  // ├── data/
  // │   ├── items.csv
  // │   └── binary.png
  // ├── cycle-link -> workspace-root (self cycle)
  // ├── docs-link -> docs (in-root symlink)
  // └── outside-link -> outside-workspace (external symlink)
  const workspaceRoot = path.join(tmpBase, 'workspace-root');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const docsDir = path.join(workspaceRoot, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'PRD.md'), '# Astor TuneUp PRD\nTarget platform: iOS & Android\n', 'utf-8');
  fs.writeFileSync(path.join(docsDir, 'architecture.txt'), 'Hybrid Gateway Architecture\n', 'utf-8');

  const mobileDir = path.join(workspaceRoot, 'mobile');
  fs.mkdirSync(mobileDir, { recursive: true });
  fs.writeFileSync(path.join(mobileDir, 'pubspec.yaml'), 'name: astor_tuneup\nversion: 1.8.0\n', 'utf-8');
  const mobileLibDir = path.join(mobileDir, 'lib');
  fs.mkdirSync(mobileLibDir, { recursive: true });
  fs.writeFileSync(path.join(mobileLibDir, 'main.dart'), 'void main() {\n  print("Astor TuneUp Running");\n}\n', 'utf-8');

  // Initialize a real Git repository in mobileDir to test clean / dirty states
  try {
    cp.execSync('git init -b feature/v1.8.0', { cwd: mobileDir, stdio: 'pipe' });
  } catch {
    try {
      cp.execSync('git init', { cwd: mobileDir, stdio: 'pipe' });
      cp.execSync('git checkout -b feature/v1.8.0', { cwd: mobileDir, stdio: 'pipe' });
    } catch {}
  }
  try {
    cp.execSync('git config user.name "Test User"', { cwd: mobileDir, stdio: 'pipe' });
    cp.execSync('git config user.email "test@example.com"', { cwd: mobileDir, stdio: 'pipe' });
    cp.execSync('git add .', { cwd: mobileDir, stdio: 'pipe' });
    cp.execSync('git commit -m "initial commit"', { cwd: mobileDir, stdio: 'pipe' });
  } catch {}

  const aiExpDir = path.join(workspaceRoot, 'ai', 'experiments');
  fs.mkdirSync(path.join(aiExpDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(aiExpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
  fs.writeFileSync(path.join(aiExpDir, 'pyproject.toml'), '[tool.poetry]\nname = "astor-ai"\n', 'utf-8');
  fs.writeFileSync(path.join(aiExpDir, 'train.py'), 'import os\nprint("Training model...")\n', 'utf-8');

  const backendDir = path.join(workspaceRoot, 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify({ name: 'astor-backend', version: '1.0.0' }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(backendDir, 'server.ts'), 'console.log("Backend server listening");\n', 'utf-8');

  const dataDir = path.join(workspaceRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'items.csv'), 'id,name,value\n1,alpha,100\n2,beta,200\n', 'utf-8');
  fs.writeFileSync(path.join(dataDir, 'binary.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]));

  const outsideDir = path.join(tmpBase, 'outside-workspace');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP SECRET DATA OUTSIDE WORKSPACE', 'utf-8');

  // Create symlinks/junctions for cycle defense and out-of-root testing
  let symlinksSupported = false;
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(docsDir, path.join(workspaceRoot, 'docs-link'), linkType);
    fs.symlinkSync(workspaceRoot, path.join(workspaceRoot, 'cycle-link'), linkType);
    fs.symlinkSync(outsideDir, path.join(workspaceRoot, 'outside-link'), linkType);
    symlinksSupported = true;
  } catch (err) {
    // Some Windows environments without admin or Developer Mode might restrict symlinks
    symlinksSupported = false;
  }

  try {
    const registry = new ProjectRegistry();
    registry.registerProject({
      projectId: 'astor-workspace',
      displayName: 'Astor TuneUp Workspace',
      root: workspaceRoot,
      permissions: { read: true, write: true, test: true, build: true, hostExecution: true },
      commands: {
        test: {
          npm: { executable: process.execPath, args: ['-e', 'console.log("npm test passed in " + process.cwd())'] }
        },
        build: {
          npm: { executable: process.execPath, args: ['-e', 'console.log("npm build passed in " + process.cwd())'] }
        }
      }
    });

    const executor = new TaskExecutor({ projectRegistry: registry });

    // ----------------------------------------------------
    // TEST 1: Workspace root without .git is valid
    // ----------------------------------------------------
    await test('1. local:project_status on workspace without root .git returns valid status with subrepo count', async () => {
      const res = await executor.executeTask({
        id: 't-stat-1',
        capability: 'local:project_status',
        payload: { projectId: 'astor-workspace' }
      } as any, () => {});

      assert.strictEqual(res.projectId, 'astor-workspace');
      assert.strictEqual(res.exists, true);
      assert.strictEqual(res.gitDetected, true);
      assert.strictEqual(res.discoveredRepositoriesCount, 2);
    });

    // ----------------------------------------------------
    // TEST 2: Nested Git Repository Discovery
    // ----------------------------------------------------
    await test('2. local:find_repositories discovers all nested git repositories and project types', async () => {
      const res = await executor.executeTask({
        id: 't-repos-1',
        capability: 'local:find_repositories',
        payload: { projectId: 'astor-workspace' }
      } as any, () => {});

      assert.strictEqual(res.projectId, 'astor-workspace');
      assert.strictEqual(res.count, 2);

      const paths = res.repositories.map((r: any) => r.repoRelativePath);
      assert.ok(paths.includes('mobile'));
      assert.ok(paths.includes('ai/experiments'));

      const mobileRepo = res.repositories.find((r: any) => r.repoRelativePath === 'mobile');
      assert.ok(mobileRepo.projectIndicators.includes('pubspec.yaml'));
      assert.ok(mobileRepo.projectTypes.includes('flutter'));
      assert.ok(mobileRepo.projectTypes.includes('dart'));

      const aiRepo = res.repositories.find((r: any) => r.repoRelativePath === 'ai/experiments');
      assert.ok(aiRepo.projectIndicators.includes('pyproject.toml'));
      assert.ok(aiRepo.projectTypes.includes('python'));
    });

    // ----------------------------------------------------
    // TEST 3: Git cleanliness semantics (clean vs dirty vs unknown)
    // ----------------------------------------------------
    await test('3a. local:git_status on clean repo returns isClean=true and valid branch', async () => {
      const res = await executor.executeTask({
        id: 't-git-clean',
        capability: 'local:git_status',
        payload: { projectId: 'astor-workspace', repoRelativePath: 'mobile' }
      } as any, () => {});

      assert.strictEqual(res.projectId, 'astor-workspace');
      assert.strictEqual(res.repoRelativePath, 'mobile');
      assert.strictEqual(res.gitDetected, true);
      assert.strictEqual(res.isClean, true);
      assert.strictEqual(res.gitStatusAvailable, true);
    });

    await test('3b. local:git_status on dirty repo returns isClean=false with modified changes', async () => {
      fs.writeFileSync(path.join(mobileDir, 'dirty.txt'), 'dirty file content', 'utf-8');
      try {
        const res = await executor.executeTask({
          id: 't-git-dirty',
          capability: 'local:git_status',
          payload: { projectId: 'astor-workspace', repoRelativePath: 'mobile' }
        } as any, () => {});

        assert.strictEqual(res.isClean, false);
        assert.strictEqual(res.gitStatusAvailable, true);
        assert.ok(res.changes.length > 0);
      } finally {
        try { fs.unlinkSync(path.join(mobileDir, 'dirty.txt')); } catch {}
      }
    });

    await test('3c. local:git_status on mock HEAD repo returns fallback branch with isClean=null and gitStatusAvailable=false', async () => {
      const res = await executor.executeTask({
        id: 't-git-mock',
        capability: 'local:git_status',
        payload: { projectId: 'astor-workspace', repoRelativePath: 'ai/experiments' }
      } as any, () => {});

      assert.strictEqual(res.projectId, 'astor-workspace');
      assert.strictEqual(res.repoRelativePath, 'ai/experiments');
      assert.strictEqual(res.branch, 'main');
      // Cleanliness must NEVER be fabricated as true on git status failure
      assert.strictEqual(res.isClean, null);
      assert.strictEqual(res.gitStatusAvailable, false);
    });

    // ----------------------------------------------------
    // TEST 4: local:git_status without repoRelativePath on multi-repo workspace reports candidates
    // ----------------------------------------------------
    await test('4. local:git_status without repoRelativePath reports ambiguity when multiple repos exist', async () => {
      const res = await executor.executeTask({
        id: 't-git-2',
        capability: 'local:git_status',
        payload: { projectId: 'astor-workspace' }
      } as any, () => {});

      assert.strictEqual(res.projectId, 'astor-workspace');
      assert.strictEqual(res.gitDetected, true);
      assert.strictEqual(res.ambiguous, true);
      assert.ok(res.candidateRepositories.includes('mobile'));
      assert.ok(res.candidateRepositories.includes('ai/experiments'));
    });

    // ----------------------------------------------------
    // TEST 5: local:list_directory and out-of-root symlink metadata protection
    // ----------------------------------------------------
    await test('5. local:list_directory lists root entries and avoids following out-of-root symlinks for metadata', async () => {
      const rootRes = await executor.executeTask({
        id: 't-list-1',
        capability: 'local:list_directory',
        payload: { projectId: 'astor-workspace', relativePath: '.' }
      } as any, () => {});

      assert.strictEqual(rootRes.projectId, 'astor-workspace');
      assert.ok(rootRes.totalEntries >= 5);
      const names = rootRes.entries.map((e: any) => e.name);
      assert.ok(names.includes('docs'));
      assert.ok(names.includes('mobile'));
      assert.ok(names.includes('backend'));

      if (symlinksSupported) {
        const outLink = rootRes.entries.find((e: any) => e.name === 'outside-link');
        assert.ok(outLink, 'outside-link entry should be present');
        assert.strictEqual(outLink.type, 'symlink');
        // Must NOT follow external target to collect sizeBytes or modifiedTime
        assert.strictEqual(outLink.sizeBytes, undefined);
        assert.strictEqual(outLink.modifiedTime, undefined);
      }
    });

    // ----------------------------------------------------
    // TEST 6: local:find_files with recursion and pattern matching
    // ----------------------------------------------------
    await test('6. local:find_files discovers files matching pattern recursively and ignores out-of-root targets', async () => {
      const dartRes = await executor.executeTask({
        id: 't-find-1',
        capability: 'local:find_files',
        payload: { projectId: 'astor-workspace', pattern: '*.dart' }
      } as any, () => {});

      assert.strictEqual(dartRes.count, 1);
      assert.strictEqual(dartRes.files[0].name, 'main.dart');
      assert.strictEqual(dartRes.files[0].relativePath, 'mobile/lib/main.dart');

      const secretRes = await executor.executeTask({
        id: 't-find-secret',
        capability: 'local:find_files',
        payload: { projectId: 'astor-workspace', pattern: 'secret.txt' }
      } as any, () => {});

      assert.strictEqual(secretRes.count, 0, 'secret.txt outside workspace must not be found');
    });

    // ----------------------------------------------------
    // TEST 7: local:search_text with cycle defense, visited realpath, and maxDepth
    // ----------------------------------------------------
    await test('7a. local:search_text handles self-cycle links gracefully without looping or stack overflow', async () => {
      const searchRes = await executor.executeTask({
        id: 't-search-cycle',
        capability: 'local:search_text',
        payload: { projectId: 'astor-workspace', query: 'Astor TuneUp' }
      } as any, () => {});

      assert.ok(searchRes.count >= 2);
      const matchedFiles = searchRes.matches.map((m: any) => m.relativePath);
      assert.ok(matchedFiles.includes('docs/PRD.md'));
      assert.ok(matchedFiles.includes('mobile/lib/main.dart'));
      assert.ok(!matchedFiles.includes('data/binary.png'));

      // Outside secret file must never be read or matched
      const outsideSearch = await executor.executeTask({
        id: 't-search-out',
        capability: 'local:search_text',
        payload: { projectId: 'astor-workspace', query: 'TOP SECRET' }
      } as any, () => {});

      assert.strictEqual(outsideSearch.count, 0, 'Out-of-root contents must not be matched');
    });

    await test('7b. local:search_text honors maxDepth parameter', async () => {
      // depth 0: only files at root (which has none matching 'Training')
      const depth0Res = await executor.executeTask({
        id: 't-search-d0',
        capability: 'local:search_text',
        payload: { projectId: 'astor-workspace', query: 'Training', maxDepth: 0 }
      } as any, () => {});
      assert.strictEqual(depth0Res.count, 0);

      // depth 2: reaches ai/experiments/train.py
      const depth2Res = await executor.executeTask({
        id: 't-search-d2',
        capability: 'local:search_text',
        payload: { projectId: 'astor-workspace', query: 'Training', maxDepth: 2 }
      } as any, () => {});
      assert.strictEqual(depth2Res.count, 1);
      assert.strictEqual(depth2Res.matches[0].relativePath, 'ai/experiments/train.py');
    });

    // ----------------------------------------------------
    // TEST 8: local:create_directory & nested file operations
    // ----------------------------------------------------
    await test('8. local:create_directory creates nested directories and local:write_file creates nested files', async () => {
      const createRes = await executor.executeTask({
        id: 't-mkdir-1',
        capability: 'local:create_directory',
        payload: { projectId: 'astor-workspace', relativePath: 'mobile/test/unit' }
      } as any, () => {});

      assert.strictEqual(createRes.status, 'created');
      assert.ok(fs.existsSync(path.join(workspaceRoot, 'mobile', 'test', 'unit')));

      const writeRes = await executor.executeTask({
        id: 't-write-1',
        capability: 'local:write_file',
        payload: {
          projectId: 'astor-workspace',
          relativePath: 'mobile/test/unit/app_test.dart',
          content: 'void main() { test("dummy", () {}); }'
        }
      } as any, () => {});

      assert.strictEqual(writeRes.status, 'written');
      assert.ok(fs.existsSync(path.join(workspaceRoot, 'mobile', 'test', 'unit', 'app_test.dart')));
    });

    // ----------------------------------------------------
    // TEST 9: Subproject Test & Build with workingRelativePath
    // ----------------------------------------------------
    await test('9. local:run_tests and local:build_project execute in subproject directory using workingRelativePath', async () => {
      let testLogs: string[] = [];
      const testRes = await executor.executeTask({
        id: 't-run-1',
        capability: 'local:run_tests',
        payload: { projectId: 'astor-workspace', runnerId: 'npm', workingRelativePath: 'backend' }
      } as any, (l) => testLogs.push(l));

      assert.strictEqual(testRes.exitCode, 0);
      assert.ok(testRes.stdout.includes('backend'));

      let buildLogs: string[] = [];
      const buildRes = await executor.executeTask({
        id: 't-build-1',
        capability: 'local:build_project',
        payload: { projectId: 'astor-workspace', commandId: 'npm', workingRelativePath: 'backend' }
      } as any, (l) => buildLogs.push(l));

      assert.strictEqual(buildRes.exitCode, 0);
      assert.ok(buildRes.stdout.includes('backend'));
    });

    // ----------------------------------------------------
    // TEST 10: Security Boundary & Path Confinement
    // ----------------------------------------------------
    await test('10. Path traversal and escape attempts are strictly rejected on all discovery tools', async () => {
      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-1',
          capability: 'local:list_directory',
          payload: { projectId: 'astor-workspace', relativePath: '../outside-workspace' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-2',
          capability: 'local:find_files',
          payload: { projectId: 'astor-workspace', relativePath: '..\\outside-workspace' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-3',
          capability: 'local:search_text',
          payload: { projectId: 'astor-workspace', relativePath: '../../outside-workspace', query: 'TOP SECRET' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-4',
          capability: 'local:create_directory',
          payload: { projectId: 'astor-workspace', relativePath: '../outside-workspace/bad-dir' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-5',
          capability: 'local:run_tests',
          payload: { projectId: 'astor-workspace', runnerId: 'npm', workingRelativePath: '../outside-workspace' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');
    });

    // ----------------------------------------------------
    // TEST 11: End-to-End MCP Handlers Integration
    // ----------------------------------------------------
    await test('11. MCP Handlers correctly expose all new workspace discovery tools and validate scopes', async () => {
      const testStorageDir = path.join(tmpBase, '.devspace-storage-discovery');
      const gateway = new GatewayServer({
        port: 0,
        masterSecret: 'test-master-secret-workspace-discovery-32b',
        storageDir: testStorageDir
      });

      const handlers = new McpHandlers(gateway);

      const readerCaller: McpCallerContext = {
        scopes: ['mcp:access', 'tasks:submit', 'tasks:read', 'local:read'],
        subjectId: 'reader-client'
      };

      const listTask = await handlers.handleLocalListDirectory({ projectId: 'astor-workspace' }, readerCaller);
      assert.ok(listTask.taskId);

      const findTask = await handlers.handleLocalFindFiles({ projectId: 'astor-workspace', pattern: '*.dart' }, readerCaller);
      assert.ok(findTask.taskId);

      const searchTask = await handlers.handleLocalSearchText({ projectId: 'astor-workspace', query: 'Astor', maxDepth: 10 }, readerCaller);
      assert.ok(searchTask.taskId);

      const repoTask = await handlers.handleLocalFindRepositories({ projectId: 'astor-workspace' }, readerCaller);
      assert.ok(repoTask.taskId);

      await assert.rejects(async () => {
        await handlers.handleLocalCreateDirectory({ projectId: 'astor-workspace', relativePath: 'new-dir' }, readerCaller);
      }, (err: any) => err.message.includes('AUTH_FORBIDDEN') || err.message.includes('local:write'));

      const writerCaller: McpCallerContext = {
        scopes: ['mcp:access', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:exec'],
        subjectId: 'writer-client'
      };
      const mkdirTask = await handlers.handleLocalCreateDirectory({ projectId: 'astor-workspace', relativePath: 'new-dir' }, writerCaller);
      assert.ok(mkdirTask.taskId);
    });

  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }

  console.log(`\nLocal Workspace Discovery Integration Tests: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}
