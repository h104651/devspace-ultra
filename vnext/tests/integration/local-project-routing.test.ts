import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { GatewayServer } from '../../src/gateway/server';
import { LocalAgentClient } from '../../src/local-agent/client';
import { TaskExecutor } from '../../src/local-agent/task-executor';
import { ProjectRegistry } from '../../src/local-agent/project-registry';
import { McpHandlers, McpCallerContext } from '../../src/mcp/handlers';

export async function runLocalProjectRoutingIntegrationTests(): Promise<{ passed: number; failed: number }> {
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

  const tmpBase = path.join(os.tmpdir(), `devspace-multiproject-e2e-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  const rootA = path.join(tmpBase, 'project-a');
  const rootB = path.join(tmpBase, 'project-b');
  const rootReadOnly = path.join(tmpBase, 'project-readonly');
  const rootNoExec = path.join(tmpBase, 'project-no-exec');

  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(rootReadOnly, { recursive: true });
  fs.mkdirSync(rootNoExec, { recursive: true });

  const initialAContent = 'Hello Project A!\nOriginal Line 2\n';
  fs.writeFileSync(path.join(rootA, 'greeting.txt'), initialAContent, 'utf-8');
  fs.writeFileSync(path.join(rootB, 'greeting.txt'), 'Greetings from PROJECT_B', 'utf-8');
  fs.writeFileSync(path.join(rootReadOnly, 'readonly.txt'), 'Read Only Content', 'utf-8');
  fs.writeFileSync(path.join(rootNoExec, 'package.json'), JSON.stringify({ name: 'no-exec' }), 'utf-8');

  try {
    // ----------------------------------------------------
    // PART 1: TaskExecutor Direct Unit / Routing Tests
    // ----------------------------------------------------
    const registry = new ProjectRegistry();
    registry.registerProject({
      projectId: 'project-a',
      displayName: 'Project Alpha',
      root: rootA,
      permissions: { read: true, write: true, test: true, build: true, hostExecution: true }
    });
    registry.registerProject({
      projectId: 'project-b',
      displayName: 'Project Beta',
      root: rootB,
      permissions: { read: true, write: true, test: true, build: true, hostExecution: true }
    });
    registry.registerProject({
      projectId: 'project-readonly',
      displayName: 'Project Read Only',
      root: rootReadOnly,
      permissions: { read: true, write: false, test: false, build: false, hostExecution: false }
    });
    registry.registerProject({
      projectId: 'project-no-exec',
      displayName: 'Project No Host Exec',
      root: rootNoExec,
      permissions: { read: true, write: true, test: true, build: true, hostExecution: false }
    });

    const executor = new TaskExecutor({ projectRegistry: registry, allowRawShell: false });

    function makeTask(capability: string, payload: any): any {
      return {
        taskId: `t-${Math.random().toString(36).substring(2, 9)}`,
        backend: 'local',
        capability,
        payload,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        priority: 0,
        requiredScope: 'local:read',
        retryPolicy: { maxRetries: 3, backoffMs: 1000 },
        artifacts: [],
        logs: []
      };
    }

    await test('TaskExecutor: local:list_projects returns safe metadata with security model and hostExecutionEnabled', async () => {
      const logs: string[] = [];
      const res = await executor.executeTask(makeTask('local:list_projects', {}), l => logs.push(l));

      assert.strictEqual(res.count, 4);
      const projA = res.projects.find((p: any) => p.projectId === 'project-a');
      assert.strictEqual(projA.hostExecutionEnabled, true);
      assert.strictEqual(projA.securityModel.fileOperations, 'PROJECT_ROOT_CONFINED');
      assert.strictEqual(projA.securityModel.processExecution, 'HOST_EXECUTION_NOT_OS_SANDBOXED');

      const projNoExec = res.projects.find((p: any) => p.projectId === 'project-no-exec');
      assert.strictEqual(projNoExec.hostExecutionEnabled, false);
    });

    await test('TaskExecutor: Host process execution boundary blocks test/build without hostExecution: true', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:run_tests', { projectId: 'project-no-exec' }), l => logs.push(l)),
        /LOCAL_PROJECT_PERMISSION_DENIED/
      );
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:build_project', { projectId: 'project-no-exec' }), l => logs.push(l)),
        /LOCAL_PROJECT_PERMISSION_DENIED/
      );
    });

    await test('TaskExecutor: Multi-project switching — Project A read vs Project B read', async () => {
      const logs: string[] = [];
      const resA = await executor.executeTask(makeTask('local:read_file', { projectId: 'project-a', relativePath: 'greeting.txt' }), l => logs.push(l));
      const resB = await executor.executeTask(makeTask('local:read_file', { projectId: 'project-b', relativePath: 'greeting.txt' }), l => logs.push(l));

      assert.strictEqual(resA.content, initialAContent);
      assert.strictEqual(resB.content, 'Greetings from PROJECT_B');
    });

    // ----------------------------------------------------
    // Deterministic Structured Patch & Concurrent OCC Tests
    // ----------------------------------------------------
    await test('TaskExecutor: patch_file fails closed on SHA mismatch (zero write)', async () => {
      const logs: string[] = [];
      const wrongSha = '0000000000000000000000000000000000000000000000000000000000000000';
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:patch_file', {
          projectId: 'project-a',
          relativePath: 'greeting.txt',
          expectedSha256: wrongSha,
          patches: [{ oldText: 'Original Line 2', newText: 'Modified Line 2' }]
        }), l => logs.push(l)),
        /LOCAL_FILE_CONFLICT/
      );
      assert.strictEqual(fs.readFileSync(path.join(rootA, 'greeting.txt'), 'utf-8'), initialAContent);
    });

    await test('TaskExecutor: patch_file fails closed on ambiguous occurrence count (zero write)', async () => {
      const logs: string[] = [];
      const multiContent = 'FOO\nBAR\nFOO\n';
      fs.writeFileSync(path.join(rootA, 'ambiguous.txt'), multiContent, 'utf-8');
      const sha = crypto.createHash('sha256').update(multiContent).digest('hex');

      await assert.rejects(
        async () => executor.executeTask(makeTask('local:patch_file', {
          projectId: 'project-a',
          relativePath: 'ambiguous.txt',
          expectedSha256: sha,
          patches: [{ oldText: 'FOO', newText: 'BAR', expectedOccurrences: 1 }] // actual is 2
        }), l => logs.push(l)),
        /LOCAL_PATCH_FAILED/
      );
      assert.strictEqual(fs.readFileSync(path.join(rootA, 'ambiguous.txt'), 'utf-8'), multiContent);
    });

    await test('TaskExecutor: Concurrent patch tasks on SAME file serialize and block lost updates (exactly 1 succeeds)', async () => {
      const initialFile = 'Concurrent Test Line 1\nTarget Line 2\n';
      fs.writeFileSync(path.join(rootA, 'concurrent.txt'), initialFile, 'utf-8');
      const initialSha = crypto.createHash('sha256').update(initialFile).digest('hex');

      const logsA: string[] = [];
      const logsB: string[] = [];

      const taskA = executor.executeTask(makeTask('local:patch_file', {
        projectId: 'project-a',
        relativePath: 'concurrent.txt',
        expectedSha256: initialSha,
        patches: [{ oldText: 'Target Line 2', newText: 'Task A Winner' }]
      }), l => logsA.push(l));

      const taskB = executor.executeTask(makeTask('local:patch_file', {
        projectId: 'project-a',
        relativePath: 'concurrent.txt',
        expectedSha256: initialSha,
        patches: [{ oldText: 'Target Line 2', newText: 'Task B Winner' }]
      }), l => logsB.push(l));

      const results = await Promise.allSettled([taskA, taskB]);
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent mutation must succeed');
      assert.strictEqual(rejected.length, 1, 'The competing concurrent mutation must fail');
      assert.strictEqual((rejected[0] as PromiseRejectedResult).reason?.message.includes('LOCAL_FILE_CONFLICT'), true);
    });

    await test('TaskExecutor: Concurrent mutations on DIFFERENT files execute in parallel without cross-blocking', async () => {
      fs.writeFileSync(path.join(rootA, 'parallel1.txt'), 'Initial 1\n', 'utf-8');
      fs.writeFileSync(path.join(rootA, 'parallel2.txt'), 'Initial 2\n', 'utf-8');
      const sha1 = crypto.createHash('sha256').update('Initial 1\n').digest('hex');
      const sha2 = crypto.createHash('sha256').update('Initial 2\n').digest('hex');

      const logs: string[] = [];
      const task1 = executor.executeTask(makeTask('local:patch_file', {
        projectId: 'project-a',
        relativePath: 'parallel1.txt',
        expectedSha256: sha1,
        patches: [{ oldText: 'Initial 1', newText: 'Updated 1' }]
      }), l => logs.push(l));

      const task2 = executor.executeTask(makeTask('local:patch_file', {
        projectId: 'project-a',
        relativePath: 'parallel2.txt',
        expectedSha256: sha2,
        patches: [{ oldText: 'Initial 2', newText: 'Updated 2' }]
      }), l => logs.push(l));

      const results = await Promise.all([task1, task2]);
      assert.strictEqual(results[0].status, 'patched');
      assert.strictEqual(results[1].status, 'patched');
      assert.strictEqual(fs.readFileSync(path.join(rootA, 'parallel1.txt'), 'utf-8'), 'Updated 1\n');
      assert.strictEqual(fs.readFileSync(path.join(rootA, 'parallel2.txt'), 'utf-8'), 'Updated 2\n');
    });

    // ----------------------------------------------------
    // Command Injection / Arbitrary Shell Prevention Tests
    // ----------------------------------------------------
    await test('TaskExecutor: local:run_tests rejects arbitrary customCommand', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:run_tests', {
          projectId: 'project-a',
          customCommand: 'echo EVIL && dir'
        }), l => logs.push(l)),
        /LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN/
      );
    });

    await test('TaskExecutor: local:build_project rejects arbitrary command string', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:build_project', {
          projectId: 'project-a',
          command: 'powershell -c whoami'
        }), l => logs.push(l)),
        /LOCAL_PROJECT_ARBITRARY_COMMAND_FORBIDDEN/
      );
    });

    await test('TaskExecutor: local:raw_shell is rejected when allowRawShell is false', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:raw_shell', {
          projectId: 'project-a',
          command: 'echo test'
        }), l => logs.push(l)),
        /RAW_SHELL_DENIED/
      );
    });

    await test('TaskExecutor: Write to read-only project is blocked (LOCAL_PROJECT_WRITE_FORBIDDEN)', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:write_file', { projectId: 'project-readonly', relativePath: 'test.txt', content: 'fail' }), l => logs.push(l)),
        /LOCAL_PROJECT_WRITE_FORBIDDEN/
      );
    });

    await test('TaskExecutor: Cross-project path traversal (../project-b) is rejected', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:read_file', { projectId: 'project-a', relativePath: '../project-b/greeting.txt' }), l => logs.push(l)),
        /LOCAL_PROJECT_PATH_ESCAPE/
      );
    });

    await test('TaskExecutor: Absolute path supplied in relativePath is rejected', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:read_file', { projectId: 'project-a', relativePath: path.join(rootB, 'greeting.txt') }), l => logs.push(l)),
        /LOCAL_PROJECT_PATH_ESCAPE/
      );
    });

    await test('TaskExecutor: Unknown projectId is rejected (LOCAL_PROJECT_NOT_FOUND)', async () => {
      const logs: string[] = [];
      await assert.rejects(
        async () => executor.executeTask(makeTask('local:read_file', { projectId: 'unknown-project', relativePath: 'greeting.txt' }), l => logs.push(l)),
        /LOCAL_PROJECT_NOT_FOUND/
      );
    });

    // ----------------------------------------------------
    // PART 2: Full Gateway + LocalAgent Client E2E Flow & local:exec scope check
    // ----------------------------------------------------
    const testStorageDir = path.join(tmpBase, '.devspace-storage-gateway');
    const port = 27100 + Math.floor(Math.random() * 2000);
    const server = new GatewayServer({
      port,
      host: '127.0.0.1',
      storageDir: testStorageDir,
      masterSecret: 'test-secret-multi-3'
    });

    let agent: LocalAgentClient | undefined;

    try {
      await server.start();

      const { deviceId, token: deviceToken } = server.authManager.registerDevice(
        'Multi-Project Worker',
        'windows',
        ['local:list_projects', 'local:project_status', 'local:read', 'local:write', 'local:git_status', 'local:run_tests']
      );

      agent = new LocalAgentClient({
        gatewayUrl: `ws://127.0.0.1:${port}/ws/agent`,
        deviceId,
        token: deviceToken,
        projects: [
          { projectId: 'project-a', displayName: 'Project Alpha', root: rootA, permissions: { read: true, write: true, test: true, build: true, hostExecution: true } },
          { projectId: 'project-b', displayName: 'Project Beta', root: rootB, permissions: { read: true, write: true, test: true, build: true, hostExecution: true } }
        ],
        pollIntervalMs: 50,
        heartbeatIntervalMs: 100
      });
      agent.start();

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (server.connectionManager.getConnectedAgents().length > 0) break;
      }
      assert.strictEqual(server.connectionManager.getConnectedAgents().length, 1);

      const mcpHandlers = new McpHandlers(server);

      // Caller with local:test but WITHOUT local:exec scope must be rejected
      const callerWithoutExec: McpCallerContext = {
        scopes: ['mcp:access', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:test'],
        subjectId: 'user-chatgpt-no-exec'
      };

      await test('MCP Handlers: local_run_tests requires local:exec scope (rejected without local:exec)', async () => {
        await assert.rejects(
          async () => mcpHandlers.handleLocalRunTests({ projectId: 'project-a' }, callerWithoutExec),
          /AUTH_FORBIDDEN: Required one of scopes: local:exec/
        );
      });

      // Caller with BOTH local:test and local:exec succeeds
      const fullCaller: McpCallerContext = {
        scopes: ['admin', 'mcp:access', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:test', 'local:exec'],
        subjectId: 'user-chatgpt-full'
      };

      await test('MCP Handlers: local_read_file rejects missing projectId/relativePath', async () => {
        await assert.rejects(
          async () => mcpHandlers.handleLocalReadFile({ relativePath: 'test.txt' }, fullCaller),
          /INVALID_ARGUMENT/
        );
        await assert.rejects(
          async () => mcpHandlers.handleLocalReadFile({ projectId: 'project-a' }, fullCaller),
          /INVALID_ARGUMENT/
        );
      });

      await test('MCP Gateway E2E: local_project_list discovers registered projects and metadata', async () => {
        const submitRes = await mcpHandlers.handleLocalProjectList({}, fullCaller);
        let task = server.taskStore.getTask(submitRes.taskId);
        for (let i = 0; i < 30 && task?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          task = server.taskStore.getTask(submitRes.taskId);
        }
        assert.strictEqual(task?.status, 'succeeded');
        assert.strictEqual(task?.result?.count, 2);
      });

      await test('MCP Gateway E2E: local_write_file, local_patch_file, and local_read_file flow', async () => {
        const initialNote = 'Line 1: Note\nLine 2: Target\n';
        const writeSubmit = await mcpHandlers.handleLocalWriteFile({
          projectId: 'project-b',
          relativePath: 'notes/flow-test.txt',
          content: initialNote
        }, fullCaller);

        let writeTask = server.taskStore.getTask(writeSubmit.taskId);
        for (let i = 0; i < 30 && writeTask?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          writeTask = server.taskStore.getTask(writeSubmit.taskId);
        }
        assert.strictEqual(writeTask?.status, 'succeeded');

        const shaBeforePatch = crypto.createHash('sha256').update(initialNote).digest('hex');
        const patchSubmit = await mcpHandlers.handleLocalPatchFile({
          projectId: 'project-b',
          relativePath: 'notes/flow-test.txt',
          expectedSha256: shaBeforePatch,
          patches: [{ oldText: 'Line 2: Target', newText: 'Line 2: Patched via MCP' }]
        }, fullCaller);

        let patchTask = server.taskStore.getTask(patchSubmit.taskId);
        for (let i = 0; i < 30 && patchTask?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          patchTask = server.taskStore.getTask(patchSubmit.taskId);
        }
        assert.strictEqual(patchTask?.status, 'succeeded');
        assert.strictEqual(patchTask?.result?.status, 'patched');

        const readSubmit = await mcpHandlers.handleLocalReadFile({
          projectId: 'project-b',
          relativePath: 'notes/flow-test.txt'
        }, fullCaller);

        let readTask = server.taskStore.getTask(readSubmit.taskId);
        for (let i = 0; i < 30 && readTask?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          readTask = server.taskStore.getTask(readSubmit.taskId);
        }
        assert.strictEqual(readTask?.status, 'succeeded');
        assert.strictEqual(readTask?.result?.content, 'Line 1: Note\nLine 2: Patched via MCP\n');
      });

    } finally {
      if (agent) agent.stop();
      await server.stop();
    }

  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }

  return { passed, failed };
}
