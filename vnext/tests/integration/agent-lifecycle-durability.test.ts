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

    // =========================================================================
    // REGRESSION TESTS: AGENT AUTH TRUST BOUNDARY & LEASE ENFORCEMENT
    // =========================================================================
    const WebSocketClient = (await import('ws')).default;

    // Reg 1: Client OAuth token cannot AGENT_REGISTER
    const clientToken = server.authManager.registerClient('Test OAuth Client', ['local:read', 'tasks:submit']).token;
    const wsClientBad = new WebSocketClient(`ws://127.0.0.1:${port}/ws/agent`);
    const reg1Promise = new Promise<boolean>((resolve) => {
      wsClientBad.on('open', () => {
        wsClientBad.send(JSON.stringify({
          type: 'AGENT_REGISTER',
          messageId: 'reg1',
          deviceId: 'fake-dev-1',
          token: clientToken
        }));
      });
      wsClientBad.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'ERROR' && msg.error?.includes('AUTH_FAILED')) resolve(true);
      });
      wsClientBad.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    assert.strictEqual(await reg1Promise, true, 'Client token must be rejected on AGENT_REGISTER');
    passed++;

    // Reg 2: Valid device token can register
    const devA = server.authManager.registerDevice('Device Alpha', 'windows', ['local:read', 'local:test']);
    const wsDevA = new WebSocketClient(`ws://127.0.0.1:${port}/ws/agent`);
    const reg2Promise = new Promise<boolean>((resolve) => {
      wsDevA.on('open', () => {
        wsDevA.send(JSON.stringify({
          type: 'AGENT_REGISTER',
          messageId: 'reg2',
          deviceId: devA.deviceId,
          token: devA.token
        }));
      });
      wsDevA.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'AGENT_REGISTERED' && msg.deviceId === devA.deviceId) resolve(true);
      });
      setTimeout(() => resolve(false), 1000);
    });
    assert.strictEqual(await reg2Promise, true, 'Valid device token must register successfully');
    passed++;

    // Reg 3: Mismatched deviceId rejected
    const wsMismatched = new WebSocketClient(`ws://127.0.0.1:${port}/ws/agent`);
    const reg3Promise = new Promise<boolean>((resolve) => {
      wsMismatched.on('open', () => {
        wsMismatched.send(JSON.stringify({
          type: 'AGENT_REGISTER',
          messageId: 'reg3',
          deviceId: 'dev-spoofed-other-id',
          token: devA.token
        }));
      });
      wsMismatched.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'ERROR' && msg.error?.includes('mismatch')) resolve(true);
      });
      wsMismatched.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    assert.strictEqual(await reg3Promise, true, 'Mismatched deviceId must be rejected');
    passed++;

    // Reg 4: Device B registers with its own token
    const devB = server.authManager.registerDevice('Device Beta', 'windows', ['local:write']);
    const wsDevB = new WebSocketClient(`ws://127.0.0.1:${port}/ws/agent`);
    await new Promise<void>((resolve) => {
      wsDevB.on('open', () => {
        wsDevB.send(JSON.stringify({
          type: 'AGENT_REGISTER',
          messageId: 'reg4',
          deviceId: devB.deviceId,
          token: devB.token
        }));
      });
      wsDevB.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'AGENT_REGISTERED') resolve();
      });
    });

    // Reg 5: Unauthorized capability escalation rejected
    // devA has ['local:read', 'local:test'], cannot claim task requiring 'local:write' even if polling with ['local:write']
    const taskWrite = server.taskStore.createTask({
      backend: 'local',
      capability: 'local:write',
      payload: { test: true }
    });
    wsDevA.send(JSON.stringify({
      type: 'TASK_CLAIM_POLL',
      messageId: 'poll-esc',
      supportedCapabilities: ['local:write'] // Attempt escalation
    }));
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(server.taskStore.getTask(taskWrite.taskId)?.status, 'queued', 'DevA cannot claim local:write task');
    passed++;

    // DevB claims taskWrite
    wsDevB.send(JSON.stringify({
      type: 'TASK_CLAIM_POLL',
      messageId: 'poll-b'
    }));
    await new Promise(r => setTimeout(r, 100));
    const claimedByB = server.taskStore.getTask(taskWrite.taskId);
    assert.strictEqual(claimedByB?.status, 'claimed');
    assert.strictEqual(claimedByB?.lease?.claimedBy, devB.deviceId);

    // Reg 6: Device A cannot ACK Device B task
    const ackPromise = new Promise<boolean>((resolve) => {
      const handler = (d: any) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'ERROR' && msg.error?.includes('LEASE_VIOLATION')) {
          wsDevA.off('message', handler);
          resolve(true);
        }
      };
      wsDevA.on('message', handler);
      wsDevA.send(JSON.stringify({
        type: 'TASK_ACK',
        messageId: 'ack-bad',
        taskId: taskWrite.taskId,
        deviceId: devB.deviceId // Spoofing deviceId in message
      }));
      setTimeout(() => resolve(false), 1000);
    });
    assert.strictEqual(await ackPromise, true, 'DevA cannot ACK task owned by DevB');
    assert.strictEqual(server.taskStore.getTask(taskWrite.taskId)?.status, 'claimed');
    passed++;

    // Reg 7: Device A cannot complete Device B task
    const completePromise = new Promise<boolean>((resolve) => {
      const handler = (d: any) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'ERROR' && msg.error?.includes('LEASE_VIOLATION')) {
          wsDevA.off('message', handler);
          resolve(true);
        }
      };
      wsDevA.on('message', handler);
      wsDevA.send(JSON.stringify({
        type: 'TASK_COMPLETE',
        messageId: 'comp-bad',
        taskId: taskWrite.taskId,
        result: { spoofed: true },
        deviceId: devB.deviceId // Spoofing deviceId in message
      }));
      setTimeout(() => resolve(false), 1000);
    });
    assert.strictEqual(await completePromise, true, 'DevA cannot complete task owned by DevB');
    assert.strictEqual(server.taskStore.getTask(taskWrite.taskId)?.status, 'claimed');
    passed++;

    wsDevA.close();
    wsDevB.close();
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
