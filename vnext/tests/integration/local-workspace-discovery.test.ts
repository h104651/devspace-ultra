import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskExecutor } from '../../src/local-agent/task-executor';
import { ProjectRegistry } from '../../src/local-agent/project-registry';
import { McpHandlers, McpCallerContext } from '../../src/mcp/handlers';
import { GatewayServer } from '../../src/gateway/server';
import { LocalAgentClient } from '../../src/local-agent/client';

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
  // │   ├── .git/
  // │   │   └── HEAD
  // │   ├── pubspec.yaml
  // │   └── lib/
  // │       └── main.dart
  // ├── ai/
  // │   └── experiments/
  // │       ├── .git/
  // │       │   └── HEAD
  // │       ├── pyproject.toml
  // │       └── train.py
  // ├── backend/
  // │   ├── package.json
  // │   └── server.ts
  // └── data/
  //     ├── items.csv
  //     └── binary.png
  const workspaceRoot = path.join(tmpBase, 'workspace-root');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const docsDir = path.join(workspaceRoot, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'PRD.md'), '# Astor TuneUp PRD\nTarget platform: iOS & Android\n', 'utf-8');
  fs.writeFileSync(path.join(docsDir, 'architecture.txt'), 'Hybrid Gateway Architecture\n', 'utf-8');

  const mobileDir = path.join(workspaceRoot, 'mobile');
  fs.mkdirSync(path.join(mobileDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(mobileDir, '.git', 'HEAD'), 'ref: refs/heads/feature/v1.8.0\n', 'utf-8');
  fs.writeFileSync(path.join(mobileDir, 'pubspec.yaml'), 'name: astor_tuneup\nversion: 1.8.0\n', 'utf-8');
  const mobileLibDir = path.join(mobileDir, 'lib');
  fs.mkdirSync(mobileLibDir, { recursive: true });
  fs.writeFileSync(path.join(mobileLibDir, 'main.dart'), 'void main() {\n  print("Astor TuneUp Running");\n}\n', 'utf-8');

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
      assert.strictEqual(res.gitDetected, true); // Found nested repos
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
    // TEST 3: local:git_status with repoRelativePath
    // ----------------------------------------------------
    await test('3. local:git_status with explicit repoRelativePath inspects targeted subproject', async () => {
      const res = await executor.executeTask({
        id: 't-git-1',
        capability: 'local:git_status',
        payload: { projectId: 'astor-workspace', repoRelativePath: 'mobile' }
      } as any, () => {});

      assert.strictEqual(res.projectId, 'astor-workspace');
      assert.strictEqual(res.repoRelativePath, 'mobile');
      assert.strictEqual(res.gitDetected, true);
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
    // TEST 5: local:list_directory
    // ----------------------------------------------------
    await test('5. local:list_directory lists root entries and subfolder entries with sorting and metadata', async () => {
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

      const docsRes = await executor.executeTask({
        id: 't-list-2',
        capability: 'local:list_directory',
        payload: { projectId: 'astor-workspace', relativePath: 'docs' }
      } as any, () => {});

      assert.strictEqual(docsRes.relativePath, 'docs');
      const docFiles = docsRes.entries.map((e: any) => e.name);
      assert.ok(docFiles.includes('PRD.md'));
      assert.ok(docFiles.includes('architecture.txt'));
    });

    // ----------------------------------------------------
    // TEST 6: local:find_files
    // ----------------------------------------------------
    await test('6. local:find_files discovers files matching pattern recursively', async () => {
      const dartRes = await executor.executeTask({
        id: 't-find-1',
        capability: 'local:find_files',
        payload: { projectId: 'astor-workspace', pattern: '*.dart' }
      } as any, () => {});

      assert.strictEqual(dartRes.count, 1);
      assert.strictEqual(dartRes.files[0].name, 'main.dart');
      assert.strictEqual(dartRes.files[0].relativePath, 'mobile/lib/main.dart');

      const yamlRes = await executor.executeTask({
        id: 't-find-2',
        capability: 'local:find_files',
        payload: { projectId: 'astor-workspace', pattern: 'pubspec.yaml' }
      } as any, () => {});

      assert.strictEqual(yamlRes.count, 1);
      assert.strictEqual(yamlRes.files[0].relativePath, 'mobile/pubspec.yaml');
    });

    // ----------------------------------------------------
    // TEST 7: local:search_text
    // ----------------------------------------------------
    await test('7. local:search_text finds matching text lines across workspace and skips binary files', async () => {
      const searchRes = await executor.executeTask({
        id: 't-search-1',
        capability: 'local:search_text',
        payload: { projectId: 'astor-workspace', query: 'Astor TuneUp' }
      } as any, () => {});

      assert.ok(searchRes.count >= 2);
      const matchedFiles = searchRes.matches.map((m: any) => m.relativePath);
      assert.ok(matchedFiles.includes('docs/PRD.md'));
      assert.ok(matchedFiles.includes('mobile/lib/main.dart'));

      // Ensure binary.png was skipped and not corrupted
      assert.ok(!matchedFiles.includes('data/binary.png'));
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
      // 10a: list_directory escape
      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-1',
          capability: 'local:list_directory',
          payload: { projectId: 'astor-workspace', relativePath: '../outside-workspace' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      // 10b: find_files escape
      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-2',
          capability: 'local:find_files',
          payload: { projectId: 'astor-workspace', relativePath: '..\\outside-workspace' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      // 10c: search_text escape
      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-3',
          capability: 'local:search_text',
          payload: { projectId: 'astor-workspace', relativePath: '../../outside-workspace', query: 'TOP SECRET' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      // 10d: create_directory escape
      await assert.rejects(async () => {
        await executor.executeTask({
          id: 't-sec-4',
          capability: 'local:create_directory',
          payload: { projectId: 'astor-workspace', relativePath: '../outside-workspace/bad-dir' }
        } as any, () => {});
      }, (err: any) => err.code === 'LOCAL_PROJECT_PATH_ESCAPE');

      // 10e: test workingRelativePath escape
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

      // Reader can submit list_directory
      const listTask = await handlers.handleLocalListDirectory({ projectId: 'astor-workspace' }, readerCaller);
      assert.ok(listTask.taskId);

      // Reader can submit find_files
      const findTask = await handlers.handleLocalFindFiles({ projectId: 'astor-workspace', pattern: '*.dart' }, readerCaller);
      assert.ok(findTask.taskId);

      // Reader can submit search_text
      const searchTask = await handlers.handleLocalSearchText({ projectId: 'astor-workspace', query: 'Astor' }, readerCaller);
      assert.ok(searchTask.taskId);

      // Reader can submit find_repositories
      const repoTask = await handlers.handleLocalFindRepositories({ projectId: 'astor-workspace' }, readerCaller);
      assert.ok(repoTask.taskId);

      // Reader WITHOUT local:write is denied create_directory
      await assert.rejects(async () => {
        await handlers.handleLocalCreateDirectory({ projectId: 'astor-workspace', relativePath: 'new-dir' }, readerCaller);
      }, (err: any) => err.message.includes('AUTH_FORBIDDEN') || err.message.includes('local:write'));

      // Writer with local:write can submit create_directory
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
