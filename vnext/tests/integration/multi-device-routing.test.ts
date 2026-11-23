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
import { TaskStore } from '../../src/storage/task-store';

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

  await test('Task A6: Device registration validates input, limits expiresInMs and rejects non-whitelisted scopes', async () => {
    const auth = new AuthManager(testMasterSecret);

    // (a) Scope whitelist: unauthorized scope 'admin' is rejected
    assert.throws(() => {
      auth.registerDevice('Device Admin Esc', 'windows', ['admin'], 'dev-esc-admin');
    }, /INVALID_DEVICE_SCOPE/);

    // (b) Scope whitelist: unauthorized scope 'tasks:submit' is rejected
    assert.throws(() => {
      auth.registerDevice('Device Submit Esc', 'windows', ['tasks:submit'], 'dev-esc-sub');
    }, /INVALID_DEVICE_SCOPE/);

    // (c) Expiration bounds: negative or less than 60s rejected
    assert.throws(() => {
      auth.registerDevice('Device Bad Exp', 'windows', ['local:read'], 'dev-bad-exp', 1000);
    }, /INVALID_ARGUMENT/);

    // (d) Expiration bounds: greater than 365 days rejected
    assert.throws(() => {
      auth.registerDevice('Device Huge Exp', 'windows', ['local:read'], 'dev-huge-exp', 400 * 24 * 3600 * 1000);
    }, /INVALID_ARGUMENT/);

    // (e) Name validation: empty or control chars rejected
    assert.throws(() => {
      auth.registerDevice('', 'windows', ['local:read'], 'dev-empty-name');
    }, /INVALID_ARGUMENT/);
    assert.throws(() => {
      auth.registerDevice('Device\x00Bad', 'windows', ['local:read'], 'dev-ctrl-name');
    }, /INVALID_ARGUMENT/);

    // (f) Platform validation: invalid platform rejected
    assert.throws(() => {
      auth.registerDevice('Device Bad Plat', 'solaris' as any, ['local:read'], 'dev-bad-plat');
    }, /INVALID_ARGUMENT/);

    // (g) Device ID validation: invalid characters rejected
    assert.throws(() => {
      auth.registerDevice('Device Bad ID', 'windows', ['local:read'], 'dev@invalid!');
    }, /INVALID_DEVICE_ID/);
  });

  await test('Task A7: Re-registering a previously revoked device ID permanently invalidates the old token', async () => {
    const auth = new AuthManager(testMasterSecret);
    const deviceId = 'dev-recycle-lifecycle';

    // 1. Initial registration
    const { token: oldToken } = auth.registerDevice('Recycle Dev', 'windows', ['local:read'], deviceId);
    assert.strictEqual(auth.validateToken(oldToken).valid, true);

    // 2. Revoke device
    auth.revokeDevice(deviceId, 'Decommission old unit');
    assert.strictEqual(auth.validateToken(oldToken).valid, false);
    assert.strictEqual(auth.validateToken(oldToken).error, 'DEVICE_REVOKED');

    // 3. Re-register device ID with new credentials
    const { token: newToken } = auth.registerDevice('Recycle Dev Reborn', 'windows', ['local:read', 'local:write'], deviceId);

    // 4. New token must be valid
    const newCheck = auth.validateToken(newToken);
    assert.strictEqual(newCheck.valid, true);
    assert.strictEqual(newCheck.payload?.subjectId, deviceId);

    // 5. Old token MUST REMAIN INVALID (TOKEN_REVOKED or TOKEN_SUPERSEDED)
    const oldCheck = auth.validateToken(oldToken);
    assert.strictEqual(oldCheck.valid, false);
    assert.ok(oldCheck.error?.includes('TOKEN_REVOKED') || oldCheck.error?.includes('TOKEN_SUPERSEDED'));
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
      await new Promise(r => setTimeout(r, 15)); // wait for lease to expire

      // Trigger stale recovery (or observe that background live agent poll already recovered it)
      const rec = server.taskStore.recoverStaleTasks();
      const recoveredTask = server.taskStore.getTask(task.taskId)!;
      assert.strictEqual(recoveredTask.status, 'queued');
      assert.strictEqual(recoveredTask.retryPolicy.retryCount, 1, 'retryCount must be incremented on lease expiration');
      assert.strictEqual(recoveredTask.targetDeviceId, 'win11-arm64-workstation-2', 'targetDeviceId must be preserved after stale lease recovery');
      assert.strictEqual(recoveredTask.lease, undefined);
      assert.strictEqual(recoveredTask.attempts?.length, 1);
      assert.strictEqual(recoveredTask.attempts?.[0]?.status, 'interrupted');
      assert.strictEqual(recoveredTask.attempts?.[0]?.errorCode, 'TASK_LEASE_EXPIRED');

      // Old PC still cannot claim recovered task
      const stealAttempt = server.taskStore.claimTask('win11-arm64-workstation', ['local:run_tests']);
      if (stealAttempt) {
        assert.notStrictEqual(stealAttempt.taskId, task.taskId, 'Old PC must not be assigned recovered task targeted to New PC');
      }

      // New PC (target device) can safely re-claim the recovered task (Attempt 2)
      const reClaimed = server.taskStore.claimTaskById(task.taskId, 'win11-arm64-workstation-2')!;
      assert.ok(reClaimed, 'Target device must be permitted to re-claim task after lease recovery');
      assert.strictEqual(reClaimed.status, 'claimed');
      assert.strictEqual(reClaimed.attempts?.length, 2, 'Re-claimed task must have second attempt in ledger');
      assert.strictEqual(reClaimed.attempts?.[1]?.claimedBy, 'win11-arm64-workstation-2');
    });

    await test('Task B7b: Deterministic TaskStore lease recovery and retry exhaustion in isolation', async () => {
      const isolatedStore = new TaskStore();
      const task = isolatedStore.createTask({
        backend: 'local',
        capability: 'local:run_tests',
        payload: { projectId: 'project-isolated' },
        targetDeviceId: 'isolated-device-target',
        maxRetries: 2
      });

      // Attempt 1: Claim with 1ms lease and expire
      isolatedStore.claimTaskById(task.taskId, 'isolated-device-target', 1);
      await new Promise(r => setTimeout(r, 15));
      const rec1 = isolatedStore.recoverStaleTasks();
      assert.strictEqual(rec1.recoveredCount, 1, 'First lease expiration must recover exactly 1 task');
      assert.strictEqual(rec1.failedCount, 0);
      const afterRec1 = isolatedStore.getTask(task.taskId)!;
      assert.strictEqual(afterRec1.status, 'queued');
      assert.strictEqual(afterRec1.retryPolicy.retryCount, 1);
      assert.strictEqual(afterRec1.attempts?.[0]?.status, 'interrupted');
      assert.strictEqual(afterRec1.attempts?.[0]?.errorCode, 'TASK_LEASE_EXPIRED');

      // Other device cannot steal it
      const stolen = isolatedStore.claimTask('wrong-device', ['local:run_tests']);
      assert.strictEqual(stolen, undefined);

      // Attempt 2: Target device re-claims and expires
      isolatedStore.claimTaskById(task.taskId, 'isolated-device-target', 1);
      await new Promise(r => setTimeout(r, 15));
      const rec2 = isolatedStore.recoverStaleTasks();
      assert.strictEqual(rec2.recoveredCount, 1, 'Second lease expiration must recover task');
      assert.strictEqual(rec2.failedCount, 0);
      assert.strictEqual(isolatedStore.getTask(task.taskId)?.retryPolicy.retryCount, 2);

      // Attempt 3: Target device re-claims, expires again (exceeds maxRetries=2) -> terminal 'stale'
      isolatedStore.claimTaskById(task.taskId, 'isolated-device-target', 1);
      await new Promise(r => setTimeout(r, 15));
      const rec3 = isolatedStore.recoverStaleTasks();
      assert.strictEqual(rec3.recoveredCount, 0);
      assert.strictEqual(rec3.failedCount, 1, 'Exceeding max retries must transition task to terminal stale');
      const terminalTask = isolatedStore.getTask(task.taskId)!;
      assert.strictEqual(terminalTask.status, 'stale');
      assert.strictEqual(terminalTask.error?.code, 'TASK_STALE');
      assert.strictEqual(terminalTask.targetDeviceId, 'isolated-device-target', 'targetDeviceId preserved even when terminal stale');
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

    await test('Task B9: Zero devices online with multiple registered devices rejects ambiguous local task submission', async () => {
      // Both agents temporarily stopped
      agentOld!.stop();
      agentNew!.stop();
      await new Promise(r => setTimeout(r, 100));

      // Verify 0 agents connected
      assert.strictEqual(server.connectionManager.getConnectedAgents().length, 0);

      // Verify multiple devices registered (at least 2: win11-arm64-workstation and win11-arm64-workstation-2)
      // Un-revoke old device so we have multiple active registered devices
      server.authManager.registerDevice('Old Windows PC Re-reg', 'windows', ['local:read'], 'win11-arm64-workstation');
      const registered = server.authManager.listDevices().filter(d => d.status !== 'revoked');
      assert.ok(registered.length >= 2, 'Multiple devices must be registered');

      // Submitting local task without targetDeviceId must throw AMBIGUOUS_DEVICE_TARGET
      let rejectedAmbiguous = false;
      try {
        await server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { projectId: 'project-test', relativePath: 'test.txt' }
          },
          ['admin', 'tasks:submit', 'local:read'],
          'test-user'
        );
      } catch (err: any) {
        if (err.message?.includes('AMBIGUOUS_DEVICE_TARGET')) rejectedAmbiguous = true;
      }
      assert.strictEqual(rejectedAmbiguous, true, 'Zero devices online with multiple registered devices must reject ambiguous submission');
    });

    await test('Task B10: Zero devices online with exactly one registered device auto-binds targetDeviceId safely', async () => {
      const singleDevServer = new GatewayServer({
        port: 0,
        host: '127.0.0.1',
        storageDir: path.join(tmpBase, 'single-dev-box'),
        masterSecret: testMasterSecret
      });
      try {
        await singleDevServer.start();
        singleDevServer.authManager.registerDevice('Sole Station', 'windows', ['local:read'], 'sole-station-01');

        assert.strictEqual(singleDevServer.connectionManager.getConnectedAgents().length, 0);
        assert.strictEqual(singleDevServer.authManager.listDevices().filter(d => d.status !== 'revoked').length, 1);

        const res = await singleDevServer.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { projectId: 'p1', relativePath: 'f.txt' }
          },
          ['admin', 'tasks:submit', 'local:read'],
          'client-user'
        );

        assert.strictEqual(res.task.targetDeviceId, 'sole-station-01', 'Task must be auto-bound to the sole registered device');
      } finally {
        await singleDevServer.stop();
      }
    });

    await test('Task B11: Idempotency replay with a conflicting targetDeviceId throws IDEMPOTENCY_CONFLICT', async () => {
      const idempKey = 'idemp-multi-dev-test-' + Date.now();

      // First submission targeting device-A
      const resA = await server.taskRouter.routeTaskSubmit(
        {
          backend: 'local',
          capability: 'local:read_file',
          payload: { projectId: 'project-new', relativePath: 'readme.txt' },
          targetDeviceId: 'win11-arm64-workstation-2',
          idempotencyKey: idempKey
        },
        ['admin', 'tasks:submit', 'local:read'],
        'caller-1'
      );
      assert.strictEqual(resA.isReplay, false);

      // Replay with matching targetDeviceId succeeds
      const replayMatch = await server.taskRouter.routeTaskSubmit(
        {
          backend: 'local',
          capability: 'local:read_file',
          payload: { projectId: 'project-new', relativePath: 'readme.txt' },
          targetDeviceId: 'win11-arm64-workstation-2',
          idempotencyKey: idempKey
        },
        ['admin', 'tasks:submit', 'local:read'],
        'caller-1'
      );
      assert.strictEqual(replayMatch.isReplay, true);
      assert.strictEqual(replayMatch.taskId, resA.taskId);

      // Replay with DIFFERENT targetDeviceId throws IDEMPOTENCY_CONFLICT
      let conflictCaught = false;
      try {
        await server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { projectId: 'project-new', relativePath: 'readme.txt' },
            targetDeviceId: 'other-device-999',
            idempotencyKey: idempKey
          },
          ['admin', 'tasks:submit', 'local:read'],
          'caller-1'
        );
      } catch (err: any) {
        if (err.message?.includes('IDEMPOTENCY_CONFLICT')) conflictCaught = true;
      }
      assert.strictEqual(conflictCaught, true, 'Reusing idempotencyKey with different targetDeviceId must throw IDEMPOTENCY_CONFLICT');
    });

    await test('Task B12: Legacy unassigned tasks are safely migrated and fail closed when ambiguous in multi-device environment', async () => {
      const memStore = new TaskStore();

      // 1. Legacy task with prior lease/attempt by 'device-alpha'
      const legacyClaimed = memStore.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'a.txt' }
      });
      // Simulate prior claim before multi-device migration
      memStore.claimTaskById(legacyClaimed.taskId, 'device-alpha');
      // Device disconnects / lease expires, requeue
      memStore.failTask(legacyClaimed.taskId, { code: 'DISCONNECT', message: 'Agent disconnected' }, { retryable: true });

      // 2. Legacy task queued with single known device
      const legacySingle = memStore.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'b.txt' }
      });

      // 3. Legacy task queued with multiple known devices
      const legacyAmbiguous = memStore.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'c.txt' }
      });

      // Run migration:
      // With 1 device: legacySingle binds to sole device
      memStore.migrateLegacyUnassignedTasks(['sole-device-01']);
      assert.strictEqual(memStore.getTask(legacyClaimed.taskId)?.targetDeviceId, 'device-alpha', 'Prior claimant must be preserved');
      assert.strictEqual(memStore.getTask(legacySingle.taskId)?.targetDeviceId, 'sole-device-01', 'Single known device must be auto-bound');

      // Reset legacyAmbiguous to have no targetDeviceId and simulate multi-device environment
      const taskAmb = memStore.getTask(legacyAmbiguous.taskId)!;
      taskAmb.targetDeviceId = undefined;
      taskAmb.status = 'queued';

      memStore.migrateLegacyUnassignedTasks(['device-1', 'device-2']);
      assert.strictEqual(memStore.getTask(taskAmb.taskId)?.status, 'failed', 'Ambiguous legacy task must fail closed');
      assert.strictEqual((memStore.getTask(taskAmb.taskId)?.error as any)?.code, 'AMBIGUOUS_LEGACY_TASK');

      // 4. Verify that once targeted, task cannot be stolen on retry
      const targetedTask = memStore.createTask({
        backend: 'local',
        capability: 'local:write_file',
        payload: { path: 'd.txt' },
        targetDeviceId: 'device-X'
      });
      // Claimed by device-X
      const claimedByX = memStore.claimTask('device-X', ['local:write_file']);
      assert.ok(claimedByX);
      assert.strictEqual(claimedByX.targetDeviceId, 'device-X');
      // Fails / requeues
      memStore.failTask(targetedTask.taskId, { code: 'CRASH', message: 'crash' }, { retryable: true });
      // device-Y cannot steal it
      const stolenByY = memStore.claimTask('device-Y', ['local:write_file']);
      assert.strictEqual(stolenByY, undefined);
    });

    await test('Task B13: Full Idempotency conflict matrix on parameters and authorization enforcement', async () => {
      const keyBase = 'idemp-matrix-' + Date.now();
      const validScopes = ['admin', 'tasks:submit', 'local:read', 'local:write'];

      // Baseline submission
      const baseKey = keyBase + '-base';
      const baseRes = await server.taskRouter.routeTaskSubmit(
        {
          backend: 'local',
          capability: 'local:read_file',
          payload: { path: 'base.txt' },
          targetDeviceId: 'win11-arm64-workstation',
          idempotencyKey: baseKey
        },
        validScopes,
        'caller-base'
      );
      assert.strictEqual(baseRes.isReplay, false);

      // (a) Exact match -> Replay
      const replayOk = await server.taskRouter.routeTaskSubmit(
        {
          backend: 'local',
          capability: 'local:read_file',
          payload: { path: 'base.txt' },
          targetDeviceId: 'win11-arm64-workstation',
          idempotencyKey: baseKey
        },
        validScopes,
        'caller-base'
      );
      assert.strictEqual(replayOk.isReplay, true);
      assert.strictEqual(replayOk.taskId, baseRes.taskId);

      // (b) Different targetDeviceId -> Conflict
      await assert.rejects(
        async () => server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { path: 'base.txt' },
            targetDeviceId: 'win11-arm64-workstation-2',
            idempotencyKey: baseKey
          },
          validScopes,
          'caller-base'
        ),
        /IDEMPOTENCY_CONFLICT/
      );

      // (c) Original had targetDeviceId, new request omitted it -> Conflict
      await assert.rejects(
        async () => server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { path: 'base.txt' },
            idempotencyKey: baseKey
          },
          validScopes,
          'caller-base'
        ),
        /AMBIGUOUS_DEVICE_TARGET|IDEMPOTENCY_CONFLICT/
      );

      // (d) Different capability -> Conflict
      await assert.rejects(
        async () => server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:write_file',
            payload: { path: 'base.txt' },
            targetDeviceId: 'win11-arm64-workstation',
            idempotencyKey: baseKey
          },
          validScopes,
          'caller-base'
        ),
        /IDEMPOTENCY_CONFLICT/
      );

      // (e) Different payload -> Conflict
      await assert.rejects(
        async () => server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { path: 'different.txt' },
            targetDeviceId: 'win11-arm64-workstation',
            idempotencyKey: baseKey
          },
          validScopes,
          'caller-base'
        ),
        /IDEMPOTENCY_CONFLICT/
      );

      // (f) Replay without required scopes cannot bypass auth
      await assert.rejects(
        async () => server.taskRouter.routeTaskSubmit(
          {
            backend: 'local',
            capability: 'local:read_file',
            payload: { path: 'base.txt' },
            targetDeviceId: 'win11-arm64-workstation',
            idempotencyKey: baseKey
          },
          [], // no scopes
          'unauthorized-caller'
        ),
        /AUTH_FORBIDDEN/
      );
    });

    await test('Task B14: Five distinct device states routing security matrix', async () => {
      const auth = new AuthManager('matrix-master-secret-32-chars-long!');

      // State 1: 0 registered, 0 online
      const serverState1 = new GatewayServer({
        port: 0,
        host: '127.0.0.1',
        storageDir: path.join(tmpBase, 'state-1'),
        masterSecret: 'matrix-master-secret-32-chars-long!'
      });
      // (a) Task submitted with explicit targetDeviceId is safely bound to that target
      const resState1Targeted = await serverState1.taskRouter.routeTaskSubmit(
        { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' }, targetDeviceId: 'future-device' },
        ['admin', 'tasks:submit', 'local:read'],
        'user-1'
      );
      assert.strictEqual(resState1Targeted.task.targetDeviceId, 'future-device');

      // (b) Task submitted without targetDeviceId in 0-device state: fails closed if multiple devices register
      const resState1Unassigned = await serverState1.taskRouter.routeTaskSubmit(
        { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' } },
        ['admin', 'tasks:submit', 'local:read'],
        'user-1'
      );
      assert.strictEqual(resState1Unassigned.task.targetDeviceId, undefined);
      serverState1.taskStore.migrateLegacyUnassignedTasks(['dev-1', 'dev-2']);
      assert.strictEqual(serverState1.taskStore.getTask(resState1Unassigned.taskId)?.status, 'failed');
      assert.strictEqual((serverState1.taskStore.getTask(resState1Unassigned.taskId)?.error as any)?.code, 'AMBIGUOUS_LEGACY_TASK');

      // State 2: 1 registered, 0 online -> Auto-binds to sole registered device
      const serverState2 = new GatewayServer({
        port: 0,
        host: '127.0.0.1',
        storageDir: path.join(tmpBase, 'state-2'),
        masterSecret: 'matrix-master-secret-32-chars-long!'
      });
      serverState2.authManager.registerDevice('Dev 1', 'windows', ['local:read'], 'dev-sole-1');
      const resState2 = await serverState2.taskRouter.routeTaskSubmit(
        { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' } },
        ['admin', 'tasks:submit', 'local:read'],
        'user-1'
      );
      assert.strictEqual(resState2.task.targetDeviceId, 'dev-sole-1', 'Single registered device must be auto-bound safely');

      // State 3: 2 registered, 0 online -> Fails closed with AMBIGUOUS_DEVICE_TARGET
      const serverState3 = new GatewayServer({
        port: 0,
        host: '127.0.0.1',
        storageDir: path.join(tmpBase, 'state-3'),
        masterSecret: 'matrix-master-secret-32-chars-long!'
      });
      serverState3.authManager.registerDevice('Dev 1', 'windows', ['local:read'], 'dev-reg-1');
      serverState3.authManager.registerDevice('Dev 2', 'windows', ['local:read'], 'dev-reg-2');
      await assert.rejects(
        async () => serverState3.taskRouter.routeTaskSubmit(
          { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' } },
          ['admin', 'tasks:submit', 'local:read'],
          'user-1'
        ),
        /AMBIGUOUS_DEVICE_TARGET/
      );

      // State 4: 1 online, 2 registered -> MUST NOT misroute to the 1 online device; fails closed with AMBIGUOUS_DEVICE_TARGET
      const mockConn1Online: any = {
        getConnectedAgents: () => [{ deviceId: 'dev-reg-1' }]
      };
      (serverState3 as any).taskRouter.connectionManager = mockConn1Online;
      await assert.rejects(
        async () => serverState3.taskRouter.routeTaskSubmit(
          { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' } },
          ['admin', 'tasks:submit', 'local:read'],
          'user-1'
        ),
        /AMBIGUOUS_DEVICE_TARGET/
      );

      // State 5: 2 online, 2 registered -> Fails closed with AMBIGUOUS_DEVICE_TARGET
      const mockConn2Online: any = {
        getConnectedAgents: () => [{ deviceId: 'dev-reg-1' }, { deviceId: 'dev-reg-2' }]
      };
      (serverState3 as any).taskRouter.connectionManager = mockConn2Online;
      await assert.rejects(
        async () => serverState3.taskRouter.routeTaskSubmit(
          { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' } },
          ['admin', 'tasks:submit', 'local:read'],
          'user-1'
        ),
        /AMBIGUOUS_DEVICE_TARGET/
      );
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
