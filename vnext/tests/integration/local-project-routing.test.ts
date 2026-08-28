import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.mkdirSync(rootReadOnly, { recursive: true });

  fs.writeFileSync(path.join(rootA, 'greeting.txt'), 'Greetings from PROJECT_A', 'utf-8');
  fs.writeFileSync(path.join(rootB, 'greeting.txt'), 'Greetings from PROJECT_B', 'utf-8');
  fs.writeFileSync(path.join(rootReadOnly, 'readonly.txt'), 'Read Only Content', 'utf-8');

  try {
    // ----------------------------------------------------
    // PART 1: TaskExecutor Direct Unit / Routing Tests
    // ----------------------------------------------------
    const registry = new ProjectRegistry();
    registry.registerProject({
      projectId: 'project-a',
      displayName: 'Project Alpha',
      root: rootA,
      permissions: { read: true, write: true, test: true, build: true }
    });
    registry.registerProject({
      projectId: 'project-b',
      displayName: 'Project Beta',
      root: rootB,
      permissions: { read: true, write: true, test: true, build: true }
    });
    registry.registerProject({
      projectId: 'project-readonly',
      displayName: 'Project Read Only',
      root: rootReadOnly,
      permissions: { read: true, write: false, test: false, build: false }
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

    await test('TaskExecutor: local:list_projects returns safe metadata list', async () => {
      const logs: string[] = [];
      const res = await executor.executeTask(makeTask('local:list_projects', {}), l => logs.push(l));

      assert.strictEqual(res.count, 3);
      assert.strictEqual(res.projects.some((p: any) => p.projectId === 'project-a'), true);
      assert.strictEqual(res.projects.some((p: any) => p.projectId === 'project-b'), true);
      assert.strictEqual(res.projects.some((p: any) => p.projectId === 'project-readonly'), true);
    });

    await test('TaskExecutor: local:project_status returns project status and permissions', async () => {
      const logs: string[] = [];
      const res = await executor.executeTask(makeTask('local:project_status', { projectId: 'project-a' }), l => logs.push(l));

      assert.strictEqual(res.projectId, 'project-a');
      assert.strictEqual(res.displayName, 'Project Alpha');
      assert.strictEqual(res.exists, true);
      assert.strictEqual(res.permissions.write, true);
    });

    await test('TaskExecutor: Multi-project switching — Project A read vs Project B read', async () => {
      const logs: string[] = [];
      const resA = await executor.executeTask(makeTask('local:read_file', { projectId: 'project-a', relativePath: 'greeting.txt' }), l => logs.push(l));
      const resB = await executor.executeTask(makeTask('local:read_file', { projectId: 'project-b', relativePath: 'greeting.txt' }), l => logs.push(l));

      assert.strictEqual(resA.content, 'Greetings from PROJECT_A');
      assert.strictEqual(resB.content, 'Greetings from PROJECT_B');
    });

    await test('TaskExecutor: Write to project-a routes correctly and preserves isolation', async () => {
      const logs: string[] = [];
      const writeRes = await executor.executeTask(makeTask('local:write_file', { projectId: 'project-a', relativePath: 'output/result.json', content: '{"status":"ok"}' }), l => logs.push(l));

      assert.strictEqual(writeRes.status, 'written');
      assert.strictEqual(fs.existsSync(path.join(rootA, 'output', 'result.json')), true);
      assert.strictEqual(fs.existsSync(path.join(rootB, 'output', 'result.json')), false);
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

    await test('TaskExecutor: Caller-supplied cwd is ignored as authority', async () => {
      const logs: string[] = [];
      const res = await executor.executeTask(makeTask('local:read_file', {
        projectId: 'project-a',
        relativePath: 'greeting.txt',
        cwd: rootB,
        workspace: rootB
      }), l => logs.push(l));

      assert.strictEqual(res.content, 'Greetings from PROJECT_A');
    });

    // ----------------------------------------------------
    // PART 2: Full Gateway + LocalAgent Client E2E Flow
    // ----------------------------------------------------
    const testStorageDir = path.join(tmpBase, '.devspace-storage-gateway');
    const port = 27000 + Math.floor(Math.random() * 2000);
    const server = new GatewayServer({
      port,
      host: '127.0.0.1',
      storageDir: testStorageDir,
      masterSecret: 'test-secret-multi'
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
          { projectId: 'project-a', displayName: 'Project Alpha', root: rootA },
          { projectId: 'project-b', displayName: 'Project Beta', root: rootB }
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
      const caller: McpCallerContext = {
        scopes: ['admin', 'mcp:access', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:test'],
        subjectId: 'user-chatgpt'
      };

      // MCP: local_project_list
      await test('MCP Gateway E2E: local_project_list discovers registered projects', async () => {
        const submitRes = await mcpHandlers.handleLocalProjectList({}, caller);
        let task = server.taskStore.getTask(submitRes.taskId);
        for (let i = 0; i < 30 && task?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          task = server.taskStore.getTask(submitRes.taskId);
        }
        assert.strictEqual(task?.status, 'succeeded');
        assert.strictEqual(task?.result?.count, 2);
        assert.strictEqual(task?.result?.projects?.length, 2);
      });

      // MCP: local_read_file on project-a
      await test('MCP Gateway E2E: local_read_file on project-a returns Project A content', async () => {
        const submitRes = await mcpHandlers.handleLocalReadFile({
          projectId: 'project-a',
          relativePath: 'greeting.txt'
        }, caller);

        let task = server.taskStore.getTask(submitRes.taskId);
        for (let i = 0; i < 30 && task?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          task = server.taskStore.getTask(submitRes.taskId);
        }
        assert.strictEqual(task?.status, 'succeeded');
        assert.strictEqual(task?.result?.content, 'Greetings from PROJECT_A');
      });

      // MCP: local_read_file on project-b
      await test('MCP Gateway E2E: local_read_file on project-b returns Project B content', async () => {
        const submitRes = await mcpHandlers.handleLocalReadFile({
          projectId: 'project-b',
          relativePath: 'greeting.txt'
        }, caller);

        let task = server.taskStore.getTask(submitRes.taskId);
        for (let i = 0; i < 30 && task?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          task = server.taskStore.getTask(submitRes.taskId);
        }
        assert.strictEqual(task?.status, 'succeeded');
        assert.strictEqual(task?.result?.content, 'Greetings from PROJECT_B');
      });

      // MCP: local_write_file on project-b + read back
      await test('MCP Gateway E2E: local_write_file on project-b writes and reads back', async () => {
        const writeSubmit = await mcpHandlers.handleLocalWriteFile({
          projectId: 'project-b',
          relativePath: 'notes/test-output.txt',
          content: 'E2E_WRITE_SUCCESS'
        }, caller);

        let writeTask = server.taskStore.getTask(writeSubmit.taskId);
        for (let i = 0; i < 30 && writeTask?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          writeTask = server.taskStore.getTask(writeSubmit.taskId);
        }
        assert.strictEqual(writeTask?.status, 'succeeded');

        const readSubmit = await mcpHandlers.handleLocalReadFile({
          projectId: 'project-b',
          relativePath: 'notes/test-output.txt'
        }, caller);

        let readTask = server.taskStore.getTask(readSubmit.taskId);
        for (let i = 0; i < 30 && readTask?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          readTask = server.taskStore.getTask(readSubmit.taskId);
        }
        assert.strictEqual(readTask?.status, 'succeeded');
        assert.strictEqual(readTask?.result?.content, 'E2E_WRITE_SUCCESS');
      });

      // MCP: Legacy compatibility test with absolute path
      await test('MCP Gateway E2E: Legacy compatibility path continues to resolve in registered root', async () => {
        const legacyFilePath = path.join(rootA, 'greeting.txt');
        const legacySubmit = await mcpHandlers.handleLocalReadFile({
          filePath: legacyFilePath
        }, caller);

        let task = server.taskStore.getTask(legacySubmit.taskId);
        for (let i = 0; i < 30 && task?.status !== 'succeeded'; i++) {
          await new Promise(r => setTimeout(r, 50));
          task = server.taskStore.getTask(legacySubmit.taskId);
        }
        assert.strictEqual(task?.status, 'succeeded');
        assert.strictEqual(task?.result?.content, 'Greetings from PROJECT_A');
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
