import * as assert from 'assert';
import * as fs from 'fs';
import { GatewayServer } from '../../src/gateway/server';
import { LocalAgentClient } from '../../src/local-agent/client';

export async function runGatewayFlowIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-flow';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const port = 50000 + Math.floor(Math.random() * 10000);
  const server = new GatewayServer({
    port,
    storageDir: testDir,
    masterSecret: 'test-secret'
  });

  let agent: LocalAgentClient | undefined;

  try {
    await server.start();

    // 1. Register Client and Device
    const { token: clientToken } = server.authManager.registerClient('ChatGPT User', ['admin']);
    const { deviceId, token: deviceToken } = server.authManager.registerDevice('Windows Worker 1', 'windows', ['local:read', 'local:write', 'local:git_status']);

    // 2. Start Outbound Local Agent
    agent = new LocalAgentClient({
      gatewayUrl: `ws://127.0.0.1:${port}/ws/agent`,
      deviceId,
      token: deviceToken,
      allowedWorkspaces: [process.cwd()],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 100
    });
    agent.start();

    // Poll until connected
    let connected = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (server.connectionManager.getConnectedAgents().length > 0) {
        connected = true;
        break;
      }
    }
    assert.strictEqual(connected, true, 'Agent should be connected');
    passed++;

    // 3. Submit a Local Task via TaskRouter
    const submitRes = await server.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: 'local:git_status',
        payload: { workspace: process.cwd() }
      },
      ['admin'],
      'chatgpt-user'
    );

    assert.strictEqual(submitRes.status, 'queued');
    passed++;

    // 4. Wait for Outbound Agent to claim, execute, and complete
    let finalTask = server.taskStore.getTask(submitRes.taskId);
    let attempts = 0;
    while (finalTask?.status !== 'succeeded' && attempts < 40) {
      await new Promise(r => setTimeout(r, 100));
      finalTask = server.taskStore.getTask(submitRes.taskId);
      attempts++;
    }

    if (finalTask?.status !== 'succeeded') {
      console.error('Debug Gateway Task failed with:', finalTask?.error, finalTask?.logs);
    }

    assert.strictEqual(finalTask?.status, 'succeeded', 'Task should succeed');
    assert.ok(finalTask?.result, 'Task should have result');
    assert.ok(finalTask?.result.branch, 'Git status result should contain branch');
    assert.ok(finalTask?.logs.length > 0, 'Task should have streamed execution logs');
    passed++;
  } catch (err: any) {
    console.error('Gateway flow integration test failed:', err);
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
