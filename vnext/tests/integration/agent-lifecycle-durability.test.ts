import * as assert from 'assert';
import * as fs from 'fs';
import { GatewayServer } from '../../src/gateway/server';
import { LocalAgentClient } from '../../src/local-agent/client';

export async function runAgentLifecycleDurabilityTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-durability';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const port = 49400 + Math.floor(Math.random() * 1000);
  let server = new GatewayServer({
    port,
    storageDir: testDir,
    masterSecret: 'test-secret'
  });

  let agent: LocalAgentClient | undefined;

  try {
    await server.start();

    const { deviceId, token: deviceToken } = server.authManager.registerDevice('Durable Worker 1', 'windows', ['local:read', 'local:write', 'local:git_status']);

    // 1. Start Outbound Agent
    agent = new LocalAgentClient({
      gatewayUrl: `ws://127.0.0.1:${port}/ws/agent`,
      deviceId,
      token: deviceToken,
      allowedWorkspaces: [process.cwd()],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 100
    });
    agent.start();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (server.connectionManager.getConnectedAgents().length > 0) break;
    }
    assert.strictEqual(server.connectionManager.getConnectedAgents().length, 1);
    passed++;

    // 2. Submit Task 1 -> Agent executes
    const task1Res = await server.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: 'local:git_status',
        payload: { workspace: process.cwd() }
      },
      ['admin'],
      'test-client'
    );

    let t1 = server.taskStore.getTask(task1Res.taskId);
    for (let i = 0; i < 30 && t1?.status !== 'succeeded'; i++) {
      await new Promise(r => setTimeout(r, 100));
      t1 = server.taskStore.getTask(task1Res.taskId);
    }
    assert.strictEqual(t1?.status, 'succeeded');
    passed++;

    // 3. Kill Agent
    agent.stop();
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(server.connectionManager.getConnectedAgents().length, 0, 'Agent should be disconnected after kill');
    passed++;

    // 4. Restart Agent -> Reconnects and executes Task 2
    agent = new LocalAgentClient({
      gatewayUrl: `ws://127.0.0.1:${port}/ws/agent`,
      deviceId,
      token: deviceToken,
      allowedWorkspaces: [process.cwd()],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 100
    });
    agent.start();

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (server.connectionManager.getConnectedAgents().length > 0) break;
    }
    assert.strictEqual(server.connectionManager.getConnectedAgents().length, 1, 'Agent should reconnect');
    passed++;

    // 5. Crash Gateway -> Restart Gateway with same storage -> Verify task persistence
    agent.stop();
    await server.stop();

    // Start NEW Gateway instance pointing to same storage
    server = new GatewayServer({
      port,
      storageDir: testDir,
      masterSecret: 'test-secret'
    });
    await server.start();

    // Verify task1 state is intact in memory after fresh reload from disk
    const reloadedTask = server.taskStore.getTask(task1Res.taskId);
    assert.ok(reloadedTask, 'Task must persist across gateway restart');
    assert.strictEqual(reloadedTask?.status, 'succeeded');
    assert.ok(reloadedTask?.result?.branch);
    passed++;
  } catch (err: any) {
    console.error('Durability test failed:', err);
    failed++;
  } finally {
    if (agent) agent.stop();
    await server.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
