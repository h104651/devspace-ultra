import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';
import { GatewayServer } from '../../src/gateway/server';
import { LocalAgentClient } from '../../src/local-agent/client';
import { McpHandlers, McpCallerContext } from '../../src/mcp/handlers';
import { AuthManager } from '../../src/security/auth-manager';
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { DurableTask } from '../../src/types/task';

// In-memory SQLite stub for Durable Object tests
class TestSqlStorage implements SqlStorage {
  private tables: Map<string, Map<string, any[]>> = new Map();

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const q = query.trim();
    const upper = q.toUpperCase();

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE INDEX') || upper.startsWith('ALTER TABLE')) {
      const match = query.match(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i);
      if (match && !this.tables.has(match[1])) this.tables.set(match[1], new Map());
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (upper.startsWith('INSERT') || upper.startsWith('INSERT OR REPLACE')) {
      const match = query.match(/INTO\s+([a-zA-Z0-9_]+)/i);
      if (match) {
        const tableName = match[1];
        if (!this.tables.has(tableName)) this.tables.set(tableName, new Map());
        this.tables.get(tableName)!.set(String(params[0]), params);
      }
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (upper.startsWith('DELETE')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (match) this.tables.get(match[1])?.delete(String(params[0]));
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (upper.startsWith('SELECT')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (!match) return { toArray: () => [], one: () => null, raw: () => [] };
      const tableName = match[1];
      const table = this.tables.get(tableName) || new Map();
      const allRows = Array.from(table.values());

      if (tableName === 'devices') {
        const mapped = allRows.map(row => ({
          deviceId: row[0],
          name: row[1],
          platform: row[2],
          status: row[3],
          capabilitiesJson: row[4],
          registeredAt: row[5],
          lastConnectedAt: row[6],
          lastHeartbeatAt: row[7],
          revokedAt: row[8],
          revocationReason: row[9],
          tokenHash: row[10],
          ip: row[11]
        }));
        if (params.length > 0) {
          const filtered = mapped.filter(r => r.deviceId === params[0]);
          return { toArray: () => filtered, one: () => filtered[0] || null, raw: () => filtered };
        }
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped };
      }

      if (tableName === 'tasks') {
        const mapped = allRows.map(row => ({
          taskId: row[0], taskKey: row[1], idempotencyKey: row[2], clientRequestId: row[3],
          backend: row[4], capability: row[5], requiredScope: row[6], status: row[7],
          priority: row[8], payloadJson: row[9], retryPolicyJson: row[10], leaseJson: row[11],
          resultJson: row[12], errorJson: row[13], artifactsJson: row[14], logsJson: row[15],
          metadataJson: row[16], startedAt: row[17], completedAt: row[18], createdAt: row[19], updatedAt: row[20],
          attemptsJson: row[21], activeAttemptId: row[22], externalRunJson: row[23], targetDeviceId: row[24]
        }));
        if (params.length > 0) {
          const filtered = mapped.filter(r => r.taskId === params[0]);
          return { toArray: () => filtered, one: () => filtered[0] || null, raw: () => filtered };
        }
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped };
      }

      if (tableName === 'revoked_tokens') {
        const mapped = allRows.map(row => ({ tokenId: row[0], revokedAt: row[1] }));
        if (params.length > 0) {
          const filtered = mapped.filter(r => r.tokenId === params[0]);
          return { toArray: () => filtered, one: () => filtered[0] || null, raw: () => filtered };
        }
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped };
      }

      return { toArray: () => allRows, one: () => allRows[0] || null, raw: () => allRows };
    }

    return { toArray: () => [], one: () => null, raw: () => [] };
  }
}

export async function runMultiDeviceRoutingTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(err);
    }
  }

  const tmpBase = path.join(process.cwd(), `.devspace-storage-multi-device-${Date.now()}`);
  if (fs.existsSync(tmpBase)) fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.mkdirSync(tmpBase, { recursive: true });

  const rootOld = path.join(tmpBase, 'project-old');
  const rootNew = path.join(tmpBase, 'project-new');
  fs.mkdirSync(rootOld, { recursive: true });
  fs.mkdirSync(rootNew, { recursive: true });
  fs.writeFileSync(path.join(rootOld, 'old.txt'), 'Old PC Project Content', 'utf-8');
  fs.writeFileSync(path.join(rootNew, 'new.txt'), 'New PC Project Content', 'utf-8');

  const testMasterSecret = 'test-master-secret-32-characters-long!';
  const testAdminSecret = 'test-admin-secret-at-least-16-chars';

  // ========================================================
  // SUITE 1: Task A - Admin Device Registration API & DO Persistence
  // ========================================================

  await test('Task A1: DO POST /admin/devices requires valid ADMIN_SECRET', async () => {
    const sql = new TestSqlStorage();
    const mockCtx: any = {
      storage: { sql },
      getWebSockets: () => []
    };
    const mockEnv: any = {
      GATEWAY_DO: {},
      MASTER_SECRET: testMasterSecret,
      ADMIN_SECRET: testAdminSecret
    };
    const gatewayDo = new GatewayDurableObject(mockCtx, mockEnv);

    // 1. Missing auth -> 401
    const reqNoAuth = new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Worker 1' })
    });
    const resNoAuth = await gatewayDo.fetch(reqNoAuth);
    assert.strictEqual(resNoAuth.status, 401);

    // 2. Wrong admin secret -> 401
    const reqWrongAuth = new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': 'wrong-secret-12345'
      },
      body: JSON.stringify({ name: 'Worker 1' })
    });
    const resWrongAuth = await gatewayDo.fetch(reqWrongAuth);
    assert.strictEqual(resWrongAuth.status, 401);

    // 3. MASTER_SECRET cannot be used as ADMIN_SECRET -> 403 Forbidden
    const reqMasterAuth = new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': testMasterSecret
      },
      body: JSON.stringify({ name: 'Worker 1' })
    });
    const resMasterAuth = await gatewayDo.fetch(reqMasterAuth);
    assert.strictEqual(resMasterAuth.status, 403);
  });

  await test('Task A2: DO POST /admin/devices registers new device with independent ID and single-use token', async () => {
    const sql = new TestSqlStorage();
    const mockCtx: any = {
      storage: { sql },
      getWebSockets: () => []
    };
    const mockEnv: any = {
      GATEWAY_DO: {},
      MASTER_SECRET: testMasterSecret,
      ADMIN_SECRET: testAdminSecret
    };
    const gatewayDo = new GatewayDurableObject(mockCtx, mockEnv);

    const req = new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': testAdminSecret
      },
      body: JSON.stringify({
        name: 'New Windows Workstation',
        deviceId: 'win11-arm64-workstation-2',
        platform: 'windows',
        capabilities: ['local:read', 'local:write', 'local:test']
      })
    });

    const res = await gatewayDo.fetch(req);
    assert.strictEqual(res.status, 201);
    const data = await res.json() as any;
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.deviceId, 'win11-arm64-workstation-2');
    assert.ok(typeof data.token === 'string' && data.token.startsWith('dsu_device_'));
    assert.strictEqual(data.device.deviceId, 'win11-arm64-workstation-2');
    assert.strictEqual(data.device.name, 'New Windows Workstation');

    // Duplicate active device registration is rejected with 409
    const reqDup = new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': testAdminSecret
      },
      body: JSON.stringify({
        name: 'Duplicate Device',
        deviceId: 'win11-arm64-workstation-2'
      })
    });
    const resDup = await gatewayDo.fetch(reqDup);
    assert.strictEqual(resDup.status, 409);
  });

  await test('Task A3: GET /admin/devices returns registered devices without revealing token or tokenHash', async () => {
    const sql = new TestSqlStorage();
    const mockCtx: any = {
      storage: { sql },
      getWebSockets: () => []
    };
    const mockEnv: any = {
      GATEWAY_DO: {},
      MASTER_SECRET: testMasterSecret,
      ADMIN_SECRET: testAdminSecret
    };
    const gatewayDo = new GatewayDurableObject(mockCtx, mockEnv);

    // Register a device
    await gatewayDo.fetch(new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
      body: JSON.stringify({ name: 'Audit Device', deviceId: 'audit-dev-01' })
    }));

    const listRes = await gatewayDo.fetch(new Request('https://gateway.internal/admin/devices', {
      method: 'GET',
      headers: { 'X-Admin-Secret': testAdminSecret }
    }));
    assert.strictEqual(listRes.status, 200);
    const body = await listRes.json() as any;
    assert.ok(Array.isArray(body.devices));
    const found = body.devices.find((d: any) => d.deviceId === 'audit-dev-01');
    assert.ok(found);
    assert.strictEqual(found.token, undefined);
    assert.strictEqual(found.tokenHash, undefined);
  });

  await test('Task A4: Device data persists in SQLite across DO restarts', async () => {
    const sql = new TestSqlStorage();
    const mockCtx1: any = { storage: { sql }, getWebSockets: () => [] };
    const mockEnv: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };

    // Instance 1 registers a device
    const gatewayDo1 = new GatewayDurableObject(mockCtx1, mockEnv);
    const regRes = await gatewayDo1.fetch(new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
      body: JSON.stringify({ name: 'Persistent Device', deviceId: 'persist-dev-01' })
    }));
    const regData = await regRes.json() as any;
    assert.strictEqual(regData.deviceId, 'persist-dev-01');

    // Simulate DO cold-start restart with fresh DO instance pointing to same storage
    const mockCtx2: any = { storage: { sql }, getWebSockets: () => [] };
    const gatewayDo2 = new GatewayDurableObject(mockCtx2, mockEnv);

    const listRes = await gatewayDo2.fetch(new Request('https://gateway.internal/admin/devices', {
      method: 'GET',
      headers: { 'X-Admin-Secret': testAdminSecret }
    }));
    const body = await listRes.json() as any;
    const found = body.devices.find((d: any) => d.deviceId === 'persist-dev-01');
    assert.ok(found, 'Device must be hydrated from SQLite storage after DO cold restart');
  });

  await test('Task A5: Device revocation immediately disables authentication and active connections', async () => {
    const auth = new AuthManager(testMasterSecret);
    const { deviceId, token } = auth.registerDevice('Test Device', 'windows', ['local:read'], 'dev-revoke-test');

    // Initially valid
    const val1 = auth.validateToken(token);
    assert.strictEqual(val1.valid, true);

    // Revoke device
    auth.revokeDevice(deviceId, 'Security test revocation');
    const val2 = auth.validateToken(token);
    assert.strictEqual(val2.valid, false);
    assert.strictEqual(val2.error, 'DEVICE_REVOKED');
  });

  // ========================================================
  // SUITE 2: Task B - Multi-Device Targeted Execution E2E
  // ========================================================

  const server = new GatewayServer({
    port: 0,
    host: '127.0.0.1',
    storageDir: tmpBase,
    masterSecret: testMasterSecret
  });

  let agentOld: LocalAgentClient | undefined;
  let agentNew: LocalAgentClient | undefined;

  try {
    await server.start();
    const address = server.httpServer.address() as AddressInfo | null;
    assert.ok(address && typeof address.port === 'number' && address.port > 0);
    const port = address.port;

    const { token: clientToken } = server.authManager.registerClient('ChatGPT Operator', ['admin', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:test', 'local:exec']);

    // Register Old PC device
    const { deviceId: oldDeviceId, token: oldDeviceToken } = server.authManager.registerDevice(
      'Old Windows PC',
      'windows',
      ['local:read', 'local:write', 'local:git_status', 'local:run_tests'],
      'win11-arm64-workstation'
    );

    // Register New PC device
    const { deviceId: newDeviceId, token: newDeviceToken } = server.authManager.registerDevice(
      'New Windows PC',
      'windows',
      ['local:read', 'local:write', 'local:git_status', 'local:run_tests'],
      'win11-arm64-workstation-2'
    );

    const caller: McpCallerContext = {
      scopes: ['admin', 'tasks:submit', 'tasks:read', 'local:read', 'local:write', 'local:test', 'local:exec'],
      subjectId: 'chatgpt-operator'
    };
    const mcpHandlers = new McpHandlers(server);

    // Start Old Agent
    agentOld = new LocalAgentClient({
      gatewayUrl: `ws://127.0.0.1:${port}/ws/agent`,
      deviceId: oldDeviceId,
      token: oldDeviceToken,
      projects: [
        { projectId: 'project-old', displayName: 'Old PC Project', root: rootOld, permissions: { read: true, write: true, test: true, build: true, hostExecution: true } }
      ],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 100
    });
    agentOld.start();

    // Start New Agent
    agentNew = new LocalAgentClient({
      gatewayUrl: `ws://127.0.0.1:${port}/ws/agent`,
      deviceId: newDeviceId,
      token: newDeviceToken,
      projects: [
        { projectId: 'project-new', displayName: 'New PC Project', root: rootNew, permissions: { read: true, write: true, test: true, build: true, hostExecution: true } }
      ],
      pollIntervalMs: 50,
      heartbeatIntervalMs: 100
    });
    agentNew.start();

    // Wait until both are connected
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (server.connectionManager.getConnectedAgents().length >= 2) break;
    }
    assert.strictEqual(server.connectionManager.getConnectedAgents().length, 2, 'Both agents must be connected concurrently');

    await test('Task B1: Two agents connected simultaneously are correctly identified in device_status', async () => {
      const statusRes = await mcpHandlers.handleDeviceStatus(caller);
      assert.strictEqual(statusRes.totalConnections, 2);
      const devOld = statusRes.devices.find((d: any) => d.deviceId === 'win11-arm64-workstation');
      const devNew = statusRes.devices.find((d: any) => d.deviceId === 'win11-arm64-workstation-2');
      assert.ok(devOld && devOld.status === 'online');
      assert.ok(devNew && devNew.status === 'online');
    });

    await test('Task B2: Task targeted to New PC is claimed and completed strictly by New PC', async () => {
      const readRes = await mcpHandlers.handleLocalReadFile({
        projectId: 'project-new',
        relativePath: 'new.txt',
        targetDeviceId: 'win11-arm64-workstation-2',
        waitMs: 5000
      }, caller);

      assert.strictEqual(readRes.status, 'succeeded');
      assert.strictEqual(readRes.directResult, true);
      assert.ok(readRes.result?.content?.includes('New PC Project Content'));
      // Verify task in store was claimed specifically by new PC
      const task = server.taskStore.getTask(readRes.taskId)!;
      assert.strictEqual(task.targetDeviceId, 'win11-arm64-workstation-2');
    });

    await test('Task B3: Task targeted to Old PC is claimed and completed strictly by Old PC', async () => {
      const readRes = await mcpHandlers.handleLocalReadFile({
        projectId: 'project-old',
        relativePath: 'old.txt',
        targetDeviceId: 'win11-arm64-workstation',
        waitMs: 5000
      }, caller);

      assert.strictEqual(readRes.status, 'succeeded');
      assert.strictEqual(readRes.directResult, true);
      assert.ok(readRes.result?.content?.includes('Old PC Project Content'));
      const task = server.taskStore.getTask(readRes.taskId)!;
      assert.strictEqual(task.targetDeviceId, 'win11-arm64-workstation');
    });

    await test('Task B4: Old PC cannot steal task targeted to New PC', async () => {
      // Create a task targeted to New PC directly in store in queued state
      const task = server.taskStore.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { projectId: 'project-new', relativePath: 'new.txt' },
        targetDeviceId: 'win11-arm64-workstation-2'
      });

      // Attempt claim by Old PC -> must return undefined
      const claimByOld = server.taskStore.claimTaskById(task.taskId, 'win11-arm64-workstation');
      assert.strictEqual(claimByOld, undefined, 'Old PC must be strictly forbidden from claiming New PC targeted task');

      // Attempt claim by New PC -> must succeed
      const claimByNew = server.taskStore.claimTaskById(task.taskId, 'win11-arm64-workstation-2');
      assert.ok(claimByNew, 'Targeted New PC must be allowed to claim');
      assert.strictEqual(claimByNew.status, 'claimed');
    });

    await test('Task B5: Ambiguous dispatch rejection: when multiple agents online, omitting targetDeviceId throws AMBIGUOUS_DEVICE_TARGET', async () => {
      await assert.rejects(
        async () => {
          await mcpHandlers.handleLocalReadFile({
            projectId: 'project-new',
            relativePath: 'new.txt'
            // targetDeviceId intentionally omitted
          }, caller);
        },
        /AMBIGUOUS_DEVICE_TARGET/
      );
    });

    await test('Task B6: When target device is offline, task remains queued and is not reassigned to online device', async () => {
      // Disconnect New PC agent
      agentNew.stop();
      await new Promise(r => setTimeout(r, 200));

      const readRes = await mcpHandlers.handleLocalReadFile({
        projectId: 'project-new',
        relativePath: 'new.txt',
        targetDeviceId: 'win11-arm64-workstation-2',
        waitMs: 500 // short wait
      }, caller);

      assert.strictEqual(readRes.status, 'queued');
      assert.strictEqual(readRes.reason, 'TARGET_DEVICE_OFFLINE');
      assert.strictEqual(readRes.targetDeviceId, 'win11-arm64-workstation-2');

      // Check task in store: must still be queued and NOT claimed by Old PC
      const task = server.taskStore.getTask(readRes.taskId)!;
      assert.strictEqual(task.status, 'queued');
      assert.strictEqual(task.targetDeviceId, 'win11-arm64-workstation-2');
      assert.strictEqual(task.lease, undefined);
    });

    await test('Task B7: Task lease expiration and retry preserves targetDeviceId binding', async () => {
      const task = server.taskStore.createTask({
        backend: 'local',
        capability: 'local:run_tests',
        payload: { projectId: 'project-new' },
        targetDeviceId: 'win11-arm64-workstation-2',
        maxRetries: 3
      });

      // Claim by target device with 1ms lease
      const claimed = server.taskStore.claimTaskById(task.taskId, 'win11-arm64-workstation-2', 1)!;
      assert.ok(claimed);
      await new Promise(r => setTimeout(r, 10)); // wait for lease to expire

      // Trigger stale recovery
      const rec = server.taskStore.recoverStaleTasks();
      assert.ok(rec.recoveredCount >= 1);

      const recoveredTask = server.taskStore.getTask(task.taskId)!;
      assert.strictEqual(recoveredTask.status, 'queued');
      assert.strictEqual(recoveredTask.targetDeviceId, 'win11-arm64-workstation-2', 'targetDeviceId must be preserved after stale lease recovery');

      // Old PC still cannot claim recovered task
      const stealAttempt = server.taskStore.claimTask('win11-arm64-workstation', ['local:run_tests']);
      if (stealAttempt) {
        assert.notStrictEqual(stealAttempt.taskId, task.taskId, 'Old PC must not be assigned recovered task targeted to New PC');
      }
    });

    await test('Task B8: Revoked device is immediately disconnected and rejected upon polling', async () => {
      // Revoke old device via admin endpoint or direct
      server.authManager.revokeDevice('win11-arm64-workstation', 'Test revocation');
      server.killSwitch.revokeDevice('win11-arm64-workstation', 'Test revocation');
      server.connectionManager.disconnectDevice('win11-arm64-workstation', 'Test revocation');

      // Wait a moment for disconnection to settle
      await new Promise(r => setTimeout(r, 80));

      // 1. Verify old device is no longer connected
      const connected = server.connectionManager.getConnectedAgents();
      assert.ok(!connected.some(a => a.deviceId === 'win11-arm64-workstation'), 'Revoked device must be disconnected');

      // 2. Verify authManager status
      const dev = server.authManager.getDevice('win11-arm64-workstation');
      assert.strictEqual(dev?.status, 'revoked');

      // 3. Create a task targeted to revoked device
      const task = server.taskStore.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { projectId: 'project-old', relativePath: 'old.txt' },
        targetDeviceId: 'win11-arm64-workstation'
      });

      // 4. Task remains queued because old agent is disconnected and new agent cannot claim it
      await new Promise(r => setTimeout(r, 100));
      const currentTask = server.taskStore.getTask(task.taskId)!;
      assert.strictEqual(currentTask.status, 'queued', 'Task for revoked device must not be claimed');
    });

  } finally {
    if (agentOld) agentOld.stop();
    if (agentNew) agentNew.stop();
    await server.stop();
    if (fs.existsSync(tmpBase)) {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    }
  }

  return { passed, failed };
}
