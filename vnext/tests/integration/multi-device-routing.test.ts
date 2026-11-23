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
        if (/status\s+IN/i.test(query)) {
          const filtered = mapped.filter(r => params.includes(r.status));
          return { toArray: () => filtered, one: () => filtered[0] || null, raw: () => filtered };
        }
        if (/backend\s*=\s*\?/i.test(query)) {
          const filtered = mapped.filter(r => r.backend === params[0]);
          return { toArray: () => filtered, one: () => filtered[0] || null, raw: () => filtered };
        }
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
    assert.strictEqual(regRes.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(regRes.headers.get('Pragma'), 'no-cache');
    assert.deepStrictEqual(regData.device.capabilities, ['local:read', 'artifacts:read']);

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

  await test('Task A8: Device registration defaults to minimal read-only scopes and sets no-store cache headers', async () => {
    const sql = new TestSqlStorage();
    const mockCtx: any = { storage: { sql }, getWebSockets: () => [] };
    const mockEnv: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
    const gatewayDo = new GatewayDurableObject(mockCtx, mockEnv);

    // Call POST /admin/devices without capabilities
    const res = await gatewayDo.fetch(new Request('https://gateway.internal/admin/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
      body: JSON.stringify({ name: 'Minimal Scope Device', deviceId: 'min-scope-dev' })
    }));

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(res.headers.get('Pragma'), 'no-cache');

    const body = await res.json() as any;
    assert.deepStrictEqual(body.device.capabilities, ['local:read', 'artifacts:read']);
    assert.ok(body.token);

    // Also verify AuthManager directly with default arguments
    const auth = new AuthManager(testMasterSecret);
    const directReg = auth.registerDevice('Direct Default Dev', 'windows');
    assert.deepStrictEqual(directReg.record.capabilities, ['local:read', 'artifacts:read']);
    const tokenVal = auth.validateToken(directReg.token);
    assert.strictEqual(tokenVal.valid, true);
    assert.deepStrictEqual(tokenVal.payload?.scopes, ['device:connect', 'local:read', 'artifacts:read']);
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
      legacyClaimed.lease = {
        claimedBy: 'device-alpha',
        claimedAt: Date.now() - 10000,
        leaseExpiresAt: Date.now() + 50000,
        lastHeartbeatAt: Date.now() - 5000
      };
      legacyClaimed.attempts = [{
        id: 'att-legacy-1',
        attemptNumber: 1,
        claimedBy: 'device-alpha',
        claimedAt: Date.now() - 10000,
        status: 'claimed'
      }];
      legacyClaimed.activeAttemptId = 'att-legacy-1';
      legacyClaimed.status = 'claimed';
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
      // Prior claimant is preserved
      memStore.migrateLegacyUnassignedTasks();
      assert.strictEqual(memStore.getTask(legacyClaimed.taskId)?.targetDeviceId, 'device-alpha', 'Prior claimant must be preserved');
      // Tasks without claimant remain quarantined in queued without auto-binding
      assert.strictEqual(memStore.getTask(legacySingle.taskId)?.targetDeviceId, undefined, 'Unproven task is quarantined, not auto-bound');
      assert.strictEqual(memStore.getTask(legacySingle.taskId)?.status, 'queued');

      // Admin explicitly assigns quarantined task to sole-device-01
      memStore.assignQuarantinedTasks('sole-device-01', [legacySingle.taskId]);
      assert.strictEqual(memStore.getTask(legacySingle.taskId)?.targetDeviceId, 'sole-device-01', 'Admin assignment explicitly binds task');

      // In multi-device environment, ambiguous legacy task remains quarantined, neither failed nor stolen
      const taskAmb = memStore.getTask(legacyAmbiguous.taskId)!;
      assert.strictEqual(taskAmb.status, 'queued', 'Ambiguous legacy task is safely held in queued without destruction');
      assert.strictEqual(taskAmb.targetDeviceId, undefined);
      // Imposters strictly cannot claim it
      assert.strictEqual(memStore.claimTask('device-1', ['local:read_file']), undefined);
      assert.strictEqual(memStore.claimTask('device-2', ['local:read_file']), undefined);

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

      // (b) Task submitted without targetDeviceId in 0-device state: immediately rejected with DEVICE_TARGET_REQUIRED
      await assert.rejects(
        async () => serverState1.taskRouter.routeTaskSubmit(
          { backend: 'local', capability: 'local:read_file', payload: { path: 'f.txt' } },
          ['admin', 'tasks:submit', 'local:read'],
          'user-1'
        ),
        /DEVICE_TARGET_REQUIRED/
      );

      // (c) Legacy unassigned tasks already persisted prior to upgrade: safely handled by migrateLegacyUnassignedTasks
      const legacyTaskInStorage = serverState1.taskStore.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'legacy.txt' }
      });
      assert.strictEqual(legacyTaskInStorage.targetDeviceId, undefined);
      serverState1.taskStore.migrateLegacyUnassignedTasks();
      assert.strictEqual(serverState1.taskStore.getTask(legacyTaskInStorage.taskId)?.status, 'queued', 'Must remain safely quarantined in queued without destruction');
      assert.strictEqual(serverState1.taskStore.getTask(legacyTaskInStorage.taskId)?.targetDeviceId, undefined);
      assert.strictEqual(serverState1.taskStore.claimTask('dev-1', ['local:read_file']), undefined);
      assert.strictEqual(serverState1.taskStore.claimTask('dev-2', ['local:read_file']), undefined);

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

    await test('Task B15: Strict P0 verification of legacy unassigned tasks, zero-device cold start, and claim protections', async () => {
      const store = new TaskStore();

      // 1. Create a legacy-format local task without targetDeviceId
      const legacyUnassigned = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'legacy-unassigned.txt' }
      });
      assert.strictEqual(legacyUnassigned.targetDeviceId, undefined);
      assert.strictEqual(legacyUnassigned.status, 'queued');

      // 2 & 3. Simulate Gateway cold start with 0 registered devices & execute Legacy Migration:
      // In a 0-device state, unassigned tasks are preserved in queued status without data loss.
      const migZeroRes = store.migrateLegacyUnassignedTasks([]);
      assert.strictEqual(migZeroRes.failedAmbiguous, 0);
      assert.strictEqual(migZeroRes.migrated, 0);
      const preservedTask = store.getTask(legacyUnassigned.taskId);
      assert.strictEqual(preservedTask?.status, 'queued', 'Unassigned legacy task in 0-device environment is preserved without destruction');
      assert.strictEqual(preservedTask?.targetDeviceId, undefined);

      // 4 & 5. Simulate new Agent polling and verify no Agent can claim it because targetDeviceId is unset (Fail-Closed claim)
      const pollNewAgent = store.claimTask('agent-new-01', ['local:read_file']);
      assert.strictEqual(pollNewAgent, undefined, 'New agent must never claim unassigned legacy task');

      // 6. Separately verify claimTask() and claimTaskById() reject unassigned queued tasks
      const queuedUnassigned = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'queued-unassigned.txt' }
      });
      assert.strictEqual(queuedUnassigned.targetDeviceId, undefined);
      assert.strictEqual(queuedUnassigned.status, 'queued');

      // claimTask rejects unassigned local task
      const claimPoll = store.claimTask('agent-new-02', ['local:read_file']);
      assert.strictEqual(claimPoll, undefined, 'claimTask must strictly reject unassigned local tasks');

      // claimTaskById rejects unassigned local task
      const claimById = store.claimTaskById(queuedUnassigned.taskId, 'agent-new-02');
      assert.strictEqual(claimById, undefined, 'claimTaskById must strictly reject unassigned local tasks');

      // 7. Verify task with explicit targetDeviceId can be normally claimed by that device (and only that device)
      const targetedTask = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'targeted.txt' },
        targetDeviceId: 'target-agent-01'
      });
      // Wrong agent fails to claim
      assert.strictEqual(store.claimTask('wrong-agent', ['local:read_file']), undefined);
      assert.strictEqual(store.claimTaskById(targetedTask.taskId, 'wrong-agent'), undefined);
      // Correct agent claims successfully
      const claimedTargeted = store.claimTask('target-agent-01', ['local:read_file']);
      assert.ok(claimedTargeted);
      assert.strictEqual(claimedTargeted.taskId, targetedTask.taskId);
      assert.strictEqual(claimedTargeted.targetDeviceId, 'target-agent-01');
      assert.strictEqual(claimedTargeted.status, 'claimed');

      // 8. Verify legacy task with prior claimant safely binds to original device even with 0 registered devices
      const legacyPrior = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'prior.txt' }
      });
      legacyPrior.lease = {
        claimedBy: 'device-original-alpha',
        claimedAt: Date.now() - 5000,
        leaseExpiresAt: Date.now() + 50000,
        lastHeartbeatAt: Date.now() - 1000
      };
      legacyPrior.attempts = [{
        id: 'att-prior-1',
        attemptNumber: 1,
        claimedBy: 'device-original-alpha',
        claimedAt: Date.now() - 5000,
        completedAt: Date.now() - 1000,
        status: 'interrupted'
      }];
      legacyPrior.activeAttemptId = undefined;
      // Prior attempt completed/interrupted -> requeued
      legacyPrior.status = 'queued';
      legacyPrior.lease = undefined;
      legacyPrior.retryPolicy.retryCount = 1;
      assert.strictEqual(store.getTask(legacyPrior.taskId)?.status, 'queued');

      // Migrate with 0 registered devices
      const migPriorRes = store.migrateLegacyUnassignedTasks([]);
      assert.strictEqual(migPriorRes.migrated, 1, 'Task with prior claimant must be safely bound');
      assert.strictEqual(store.getTask(legacyPrior.taskId)?.targetDeviceId, 'device-original-alpha');
      // Imposter agent cannot claim it
      assert.strictEqual(store.claimTask('device-imposter', ['local:read_file']), undefined);
      // Original device claims it
      const claimedPrior = store.claimTask('device-original-alpha', ['local:read_file']);
      assert.ok(claimedPrior);
      assert.strictEqual(claimedPrior.taskId, legacyPrior.taskId);

      // 9. Verify explicit administrative assignment of quarantined tasks (no automatic guessing)
      const legacySingle = store.createTask({ backend: 'local', capability: 'local:read_file', payload: { path: 'single.txt' } });
      const migUnassigned = store.migrateLegacyUnassignedTasks();
      assert.strictEqual(migUnassigned.migrated, 0, 'Tasks without claimant are NOT auto-migrated');
      assert.strictEqual(migUnassigned.quarantined >= 1, true, 'Unassigned tasks are safely quarantined in queued');

      // Admin explicitly assigns quarantined tasks to sole-device-beta
      const assignRes = store.assignQuarantinedTasks('sole-device-beta', [legacySingle.taskId]);
      assert.strictEqual(assignRes.assigned >= 1, true, 'Quarantined tasks are assigned to designated device');
      assert.strictEqual(store.getTask(legacySingle.taskId)?.targetDeviceId, 'sole-device-beta');

      // 10. Verify SQLite persistence and Durable Object Cold Start path
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doInstance1 = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      // Save a legacy unassigned task directly to SQLite
      const rawLegacyTask: any = {
        taskId: 'do-cold-legacy-01',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'cold.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        artifacts: [],
        logs: [],
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000
      };
      await (doInstance1 as any).storage.saveTask(rawLegacyTask);

      // Cold start DO with 0 registered devices:
      const doColdInstance = new GatewayDurableObject(mockCtxDo, mockEnvDo);
      await (doColdInstance as any).initializeFromDurableStorage();

      // Verify DO cold start preserves legacy unassigned task without destruction
      const coldLoaded = (doColdInstance as any).taskStore.getTask('do-cold-legacy-01');
      assert.strictEqual(coldLoaded?.status, 'queued', 'DO cold start preserves legacy unassigned task without destruction');
      assert.strictEqual(coldLoaded?.targetDeviceId, undefined);
      // Imposter agent strictly cannot claim it
      assert.strictEqual((doColdInstance as any).taskStore.claimTask('imposter-agent', ['local:read_file']), undefined);

      // When the authoritative old agent reconnects and admin assigns:
      (doColdInstance as any).authManager.rememberAuthenticatedDevice('token-bootstrap-1', 'win11-arm64-workstation', 'Old PC', ['local:read_file']);
      (doColdInstance as any).taskStore.assignQuarantinedTasks('win11-arm64-workstation', ['do-cold-legacy-01']);
      const reconnectedLoaded = (doColdInstance as any).taskStore.getTask('do-cold-legacy-01');
      assert.strictEqual(reconnectedLoaded?.targetDeviceId, 'win11-arm64-workstation');
      const claimed = (doColdInstance as any).taskStore.claimTask('win11-arm64-workstation', ['local:read_file']);
      assert.ok(claimed);
      assert.strictEqual(claimed.taskId, 'do-cold-legacy-01');
    });

    await test('Task B16: Old agent Bootstrap Token compatibility and prohibition of re-registration', async () => {
      const auth = new AuthManager(testMasterSecret);
      // 1. Old agent boots with Bootstrap Token (HMAC signed by MASTER_SECRET)
      const { token: bootstrapToken } = auth.generateToken('win11-arm64-workstation', 'device', ['local:read', 'local:write', 'artifacts:read']);
      const valInitial = auth.validateToken(bootstrapToken);
      assert.strictEqual(valInitial.valid, true);

      // 2. Old agent establishes connection and is remembered
      auth.rememberAuthenticatedDevice(bootstrapToken, 'win11-arm64-workstation', 'Old PC', ['local:read', 'local:write']);
      assert.strictEqual(auth.getDevice('win11-arm64-workstation')?.status, 'online');
      assert.strictEqual(auth.getDevice('win11-arm64-workstation')?.activeTokenId, undefined);

      // 3. Reconnection works seamlessly with the same Bootstrap Token
      const valReconnect = auth.validateToken(bootstrapToken);
      assert.strictEqual(valReconnect.valid, true);

      // 4. Calling registerDevice on active device ID is strictly blocked
      assert.throws(() => {
        auth.registerDevice('Old PC Duplicate', 'windows', ['local:read'], 'win11-arm64-workstation');
      }, /DEVICE_ID_CONFLICT/);

      // 5. If device is revoked and re-registered with new token, old token is permanently superseded
      auth.revokeDevice('win11-arm64-workstation', 'Admin test revocation');
      const { token: newToken } = auth.registerDevice('Old PC Replaced', 'windows', ['local:read'], 'win11-arm64-workstation');
      const valOldRevoked = auth.validateToken(bootstrapToken);
      assert.strictEqual(valOldRevoked.valid, false);
      assert.ok(valOldRevoked.error?.includes('TOKEN_SUPERSEDED') || valOldRevoked.error?.includes('DEVICE_REVOKED'));
      const valNew = auth.validateToken(newToken);
      assert.strictEqual(valNew.valid, true);
    });

    await test('Task B17: Gateway cold start with zero registered devices preserves legacy queued tasks until single agent reconnects', async () => {
      // 1. Setup DO with an unassigned legacy queued task in SQLite
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doInstance = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      const legacyTask: any = {
        taskId: 'legacy-cold-queued-01',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'legacy.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        artifacts: [],
        logs: [],
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000
      };
      await (doInstance as any).storage.saveTask(legacyTask);

      // 2. Cold start DO
      const doCold = new GatewayDurableObject(mockCtxDo, mockEnvDo);
      await (doCold as any).initializeFromDurableStorage();

      // 3. Verify task is NOT failed; remains queued and un-claimable by random agent
      const loaded = (doCold as any).taskStore.getTask('legacy-cold-queued-01');
      assert.strictEqual(loaded?.status, 'queued');
      assert.strictEqual(loaded?.targetDeviceId, undefined);
      assert.strictEqual((doCold as any).taskStore.claimTask('random-agent', ['local:read_file']), undefined);

      // 4. Old Agent reconnects via WebSocket AGENT_REGISTER
      const auth = (doCold as any).authManager;
      const { token: oldToken } = auth.generateToken('win11-arm64-workstation', 'device', ['local:read', 'artifacts:read']);
      const wsFake: any = {
        _att: null,
        serializeAttachment: (att: any) => { wsFake._att = att; },
        deserializeAttachment: () => wsFake._att,
        send: () => {},
        close: () => {}
      };
      // Simulate AGENT_REGISTER message
      await (doCold as any).webSocketMessage(
        wsFake,
        JSON.stringify({
          type: 'AGENT_REGISTER',
          messageId: 'reg-msg-1',
          deviceId: 'win11-arm64-workstation',
          name: 'Old PC Agent',
          token: oldToken,
          capabilities: ['local:read_file']
        })
      );

      // 5. Verify unassigned task remains safely quarantined even after old agent reconnects (no auto-theft)
      const taskAfterReconnect = (doCold as any).taskStore.getTask('legacy-cold-queued-01');
      assert.strictEqual(taskAfterReconnect?.targetDeviceId, undefined, 'Connecting alone does NOT auto-bind unassigned tasks');
      assert.strictEqual(taskAfterReconnect?.status, 'queued');

      // 6. Admin assigns quarantined tasks to authoritative device
      const assignRes = (doCold as any).taskStore.assignQuarantinedTasks('win11-arm64-workstation', ['legacy-cold-queued-01']);
      assert.strictEqual(assignRes.assigned, 1);
      assert.strictEqual((doCold as any).taskStore.getTask('legacy-cold-queued-01')?.targetDeviceId, 'win11-arm64-workstation');

      // 7. Old agent polls and claims it successfully
      const claimed = (doCold as any).taskStore.claimTask('win11-arm64-workstation', ['local:read_file']);
      assert.ok(claimed);
      assert.strictEqual(claimed.taskId, 'legacy-cold-queued-01');
    });

    await test('Task B18: New device connecting first must NOT acquire quarantined unassigned tasks', async () => {
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doGateway = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      // Pre-existing unassigned legacy task in SQLite
      await (doGateway as any).storage.saveTask({
        taskId: 'legacy-unassigned-t18',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'secret-doc.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 60000
      });
      await (doGateway as any).initializeFromDurableStorage();

      // Register and connect NEW device first
      const auth = (doGateway as any).authManager;
      const { token: newToken } = auth.registerDevice('New Workstation', 'windows', ['local:read'], 'win11-arm64-workstation-2');

      const wsNew: any = { _att: null, serializeAttachment: (a: any) => { wsNew._att = a; }, deserializeAttachment: () => wsNew._att, send: () => {}, close: () => {} };
      await (doGateway as any).webSocketMessage(wsNew, JSON.stringify({
        type: 'AGENT_REGISTER',
        messageId: 'reg-new-1',
        deviceId: 'win11-arm64-workstation-2',
        name: 'New Workstation',
        token: newToken,
        capabilities: ['local:read_file']
      }));

      // Verify unassigned task was NOT bound to new device
      const task = (doGateway as any).taskStore.getTask('legacy-unassigned-t18');
      assert.strictEqual(task?.targetDeviceId, undefined, 'New device connecting first must NOT acquire legacy unassigned task');
      assert.strictEqual(task?.status, 'queued');

      // New device polling strictly fails closed
      const claimRes = (doGateway as any).taskStore.claimTask('win11-arm64-workstation-2', ['local:read_file']);
      assert.strictEqual(claimRes, undefined, 'New device cannot claim unassigned legacy task');
    });

    await test('Task B19: Old device connecting first only claims tasks with prior claimant or matching targetDeviceId', async () => {
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doGateway = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      // Task with verifiable historical claimant (win11-arm64-workstation)
      await (doGateway as any).storage.saveTask({
        taskId: 'task-with-claimant',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'claimant-task.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 1, backoffMs: 2000, requeueOnStale: true },
        attempts: [{
          id: 'att-19',
          attemptNumber: 1,
          claimedBy: 'win11-arm64-workstation',
          claimedAt: Date.now() - 50000,
          completedAt: Date.now() - 10000,
          status: 'interrupted'
        }],
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 10000
      });

      // Pure unassigned task without claimant
      await (doGateway as any).storage.saveTask({
        taskId: 'task-without-claimant',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'unassigned-task.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        createdAt: Date.now() - 60000,
        updatedAt: Date.now() - 60000
      });

      await (doGateway as any).initializeFromDurableStorage();

      // Task with claimant is automatically bound to historical claimant
      assert.strictEqual((doGateway as any).taskStore.getTask('task-with-claimant')?.targetDeviceId, 'win11-arm64-workstation');
      // Task without claimant remains quarantined
      assert.strictEqual((doGateway as any).taskStore.getTask('task-without-claimant')?.targetDeviceId, undefined);

      // Old device connects
      (doGateway as any).authManager.rememberAuthenticatedDevice('token-old', 'win11-arm64-workstation', 'Old PC', ['local:read_file']);

      // Old device claims task-with-claimant successfully
      const claim1 = (doGateway as any).taskStore.claimTask('win11-arm64-workstation', ['local:read_file']);
      assert.ok(claim1);
      assert.strictEqual(claim1.taskId, 'task-with-claimant');

      // Old device cannot claim task-without-claimant (quarantined)
      const claim2 = (doGateway as any).taskStore.claimTask('win11-arm64-workstation', ['local:read_file']);
      assert.strictEqual(claim2, undefined, 'Old device cannot claim unassigned task without explicit assignment');
    });

    await test('Task B20: New device registered while old device offline cannot claim quarantined legacy tasks', async () => {
      const store = new TaskStore();
      const quarantined = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { file: 'offline-test.txt' }
      });
      assert.strictEqual(quarantined.targetDeviceId, undefined);

      // New device is online and registered; old device is offline
      const claimResult = store.claimTask('win11-arm64-workstation-2', ['local:read_file']);
      assert.strictEqual(claimResult, undefined);

      const claimByIdResult = store.claimTaskById(quarantined.taskId, 'win11-arm64-workstation-2');
      assert.strictEqual(claimByIdResult, undefined);
    });

    await test('Task B21: Simultaneous multi-device reconnection preserves targetDeviceId separation without cross-claim', async () => {
      const store = new TaskStore();
      const taskDev1 = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { file: 'dev1.txt' },
        targetDeviceId: 'device-alpha'
      });
      const taskDev2 = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { file: 'dev2.txt' },
        targetDeviceId: 'device-beta'
      });

      // Device alpha claims
      const claimAlpha = store.claimTask('device-alpha', ['local:read_file']);
      assert.ok(claimAlpha);
      assert.strictEqual(claimAlpha.taskId, taskDev1.taskId);
      assert.strictEqual(claimAlpha.targetDeviceId, 'device-alpha');

      // Device beta claims
      const claimBeta = store.claimTask('device-beta', ['local:read_file']);
      assert.ok(claimBeta);
      assert.strictEqual(claimBeta.taskId, taskDev2.taskId);
      assert.strictEqual(claimBeta.targetDeviceId, 'device-beta');

      // Cross-claim is strictly blocked
      assert.strictEqual(store.claimTask('device-alpha', ['local:read_file']), undefined);
      assert.strictEqual(store.claimTask('device-beta', ['local:read_file']), undefined);
    });

    await test('Task B22: Quarantined legacy tasks require explicit admin assignment via POST /admin/tasks/assign-legacy', async () => {
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doGateway = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      // Create unassigned legacy task
      await (doGateway as any).storage.saveTask({
        taskId: 'task-admin-assign-01',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'admin-test.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 5000
      });
      await (doGateway as any).initializeFromDurableStorage();

      // Register device
      (doGateway as any).authManager.registerDevice('Target Workstation', 'windows', ['local:read'], 'win11-arm64-workstation');

      // 1. Unauthenticated admin call fails
      const unauthReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation', taskIds: ['task-admin-assign-01'] })
      });
      const unauthRes = await doGateway.fetch(unauthReq);
      assert.strictEqual(unauthRes.status, 401);

      // 2. Invalid device fails
      const invalidDevReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'non-existent-device', taskIds: ['task-admin-assign-01'] })
      });
      const invalidDevRes = await doGateway.fetch(invalidDevReq);
      assert.strictEqual(invalidDevRes.status, 400);

      // 3a. Missing taskIds fails with 400
      const missingTaskIdsReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation' })
      });
      const missingTaskIdsRes = await doGateway.fetch(missingTaskIdsReq);
      assert.strictEqual(missingTaskIdsRes.status, 400);
      const missingJson = await missingTaskIdsRes.json() as any;
      assert.ok(missingJson.error.includes('taskIds is required'));

      // 3b. Empty taskIds array fails with 400
      const emptyTaskIdsReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation', taskIds: [] })
      });
      const emptyTaskIdsRes = await doGateway.fetch(emptyTaskIdsReq);
      assert.strictEqual(emptyTaskIdsRes.status, 400);
      const emptyJson = await emptyTaskIdsRes.json() as any;
      assert.ok(emptyJson.error.includes('taskIds is required and must be a non-empty array'));

      // 3c. Revoked device fails with 400
      (doGateway as any).authManager.registerDevice('Revoked PC', 'windows', ['local:read'], 'revoked-pc');
      (doGateway as any).authManager.revokeDevice('revoked-pc');
      const revokedDevReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'revoked-pc', taskIds: ['task-admin-assign-01'] })
      });
      const revokedDevRes = await doGateway.fetch(revokedDevReq);
      assert.strictEqual(revokedDevRes.status, 400);
      const revokedJson = await revokedDevRes.json() as any;
      assert.ok(revokedJson.error.includes('is not a valid registered active device'));

      // 3d. Valid admin assignment succeeds with explicit taskIds
      const validReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation', taskIds: ['task-admin-assign-01'] })
      });
      const validRes = await doGateway.fetch(validReq);
      assert.strictEqual(validRes.status, 200);
      const resJson = await validRes.json() as any;
      assert.strictEqual(resJson.ok, true);
      assert.strictEqual(resJson.assignedCount, 1);

      // 4. Task is now bound and claimable by target device
      const assignedTask = (doGateway as any).taskStore.getTask('task-admin-assign-01');
      assert.strictEqual(assignedTask?.targetDeviceId, 'win11-arm64-workstation');

      const claimed = (doGateway as any).taskStore.claimTask('win11-arm64-workstation', ['local:read_file']);
      assert.ok(claimed);
      assert.strictEqual(claimed.taskId, 'task-admin-assign-01');
    });

    await test('Task B23: Durable Object cold start preserves quarantined tasks without auto-binding', async () => {
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doInstance1 = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      // Save unassigned task in SQLite
      await (doInstance1 as any).storage.saveTask({
        taskId: 'do-cold-test-23',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'queued',
        priority: 0,
        payload: { path: 'cold-test.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        createdAt: Date.now() - 50000,
        updatedAt: Date.now() - 50000
      });

      // Cold start second DO instance
      const doCold = new GatewayDurableObject(mockCtxDo, mockEnvDo);
      await (doCold as any).initializeFromDurableStorage();

      const task = (doCold as any).taskStore.getTask('do-cold-test-23');
      assert.strictEqual(task?.status, 'queued', 'Task must remain queued');
      assert.strictEqual(task?.targetDeviceId, undefined, 'Task targetDeviceId must remain undefined');
      assert.strictEqual((doCold as any).taskStore.claimTask('any-device', ['local:read_file']), undefined);
    });

    await test('Task B24: Multi-device disconnect, lease expiration, and stale recovery strictly preserves targetDeviceId', async () => {
      const store = new TaskStore();
      const task = store.createTask({
        backend: 'local',
        capability: 'local:read_file',
        payload: { path: 'lease-recovery.txt' },
        targetDeviceId: 'device-gamma'
      });

      // Device gamma claims task
      const claimed = store.claimTask('device-gamma', ['local:read_file'], 50);
      assert.ok(claimed);
      assert.strictEqual(claimed.status, 'claimed');
      assert.strictEqual(claimed.targetDeviceId, 'device-gamma');

      // Simulate lease expiration
      if (claimed.lease) {
        claimed.lease.leaseExpiresAt = Date.now() - 1000;
      }

      // Recover stale task
      const recovered = store.recoverStaleTasks();
      assert.ok(recovered.recoveredCount >= 1);

      // Task is back in queued, but targetDeviceId REMAINS device-gamma
      const recoveredTask = store.getTask(task.taskId);
      assert.strictEqual(recoveredTask?.status, 'queued');
      assert.strictEqual(recoveredTask?.targetDeviceId, 'device-gamma');

      // Other device (device-delta) strictly CANNOT claim it
      assert.strictEqual(store.claimTask('device-delta', ['local:read_file']), undefined);

      // Original device (device-gamma) claims it again
      const reclaimed = store.claimTask('device-gamma', ['local:read_file']);
      assert.ok(reclaimed);
      assert.strictEqual(reclaimed.taskId, task.taskId);
    });

    await test('Task B25: Active Task Status Whitelisting and Terminal Task Assignment Exclusion', async () => {
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doGateway = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      const activeStatuses = ['queued', 'claimed', 'acknowledged', 'running', 'retrying'] as const;
      const terminalStatuses = ['succeeded', 'failed', 'cancelled', 'stale'] as const;

      const allTaskIds: string[] = [];

      for (const st of activeStatuses) {
        const taskId = `task-active-${st}`;
        allTaskIds.push(taskId);
        await (doGateway as any).storage.saveTask({
          taskId,
          backend: 'local',
          capability: 'local:read_file',
          requiredScope: 'local:read',
          status: st,
          priority: 0,
          payload: { path: `${st}.txt` },
          retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
          attempts: [],
          createdAt: Date.now() - 10000,
          updatedAt: Date.now() - 10000
        });
      }

      for (const st of terminalStatuses) {
        const taskId = `task-terminal-${st}`;
        allTaskIds.push(taskId);
        await (doGateway as any).storage.saveTask({
          taskId,
          backend: 'local',
          capability: 'local:read_file',
          requiredScope: 'local:read',
          status: st,
          priority: 0,
          payload: { path: `${st}.txt` },
          retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
          attempts: [],
          createdAt: Date.now() - 20000,
          updatedAt: Date.now() - 20000
        });
      }

      await (doGateway as any).initializeFromDurableStorage();
      (doGateway as any).authManager.registerDevice('Workstation', 'windows', ['local:read'], 'win11-arm64-workstation');

      // 1. Query /admin/tasks?status=active -> must strictly whitelist the 5 active tasks
      const activeReq = new Request('http://localhost/admin/tasks?view=inventory&backend=local&status=active', {
        headers: { 'X-Admin-Secret': testAdminSecret }
      });
      const activeRes = await doGateway.fetch(activeReq);
      assert.strictEqual(activeRes.status, 200);
      const activeJson = await activeRes.json() as any;
      assert.strictEqual(activeJson.total, 5, 'Must only return 5 active tasks');
      assert.strictEqual(activeJson.summary.totalActiveLocal, 5, 'summary.totalActiveLocal must be 5');
      assert.strictEqual(activeJson.summary.totalQuarantined, 5, 'summary.totalQuarantined must be 5');
      for (const t of activeJson.tasks) {
        assert.ok(activeStatuses.includes(t.status), `Task status ${t.status} must be in active whitelist`);
        assert.ok(!terminalStatuses.includes(t.status), `Terminal task ${t.taskId} must not be in active tasks`);
      }

      // 2. Assign all tasks via assign-legacy -> MUST ONLY assign the 5 active tasks!
      const assignReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation', taskIds: allTaskIds })
      });
      const assignRes = await doGateway.fetch(assignReq);
      assert.strictEqual(assignRes.status, 200);
      const assignJson = await assignRes.json() as any;
      assert.strictEqual(assignJson.assignedCount, 5, 'Must only assign the 5 active quarantined tasks');

      // 3. Verify terminal tasks were NEVER modified (targetDeviceId remains undefined)
      for (const st of terminalStatuses) {
        const termTask = (doGateway as any).taskStore.getTask(`task-terminal-${st}`);
        assert.strictEqual(termTask?.targetDeviceId, undefined, `Terminal task task-terminal-${st} must remain immutable and unassigned`);
      }

      // 4. Verify all 5 active tasks were assigned
      for (const st of activeStatuses) {
        const actTask = (doGateway as any).taskStore.getTask(`task-active-${st}`);
        assert.strictEqual(actTask?.targetDeviceId, 'win11-arm64-workstation');
      }
    });

    await test('Task B26: Admin legacy task assignment strictly excludes tasks with active lease held by different claimant', async () => {
      const sql = new TestSqlStorage();
      const mockCtxDo: any = { storage: { sql }, getWebSockets: () => [] };
      const mockEnvDo: any = { GATEWAY_DO: {}, MASTER_SECRET: testMasterSecret, ADMIN_SECRET: testAdminSecret };
      const doGateway = new GatewayDurableObject(mockCtxDo, mockEnvDo);

      const now = Date.now();
      // Register both Device 1 and Device 2
      (doGateway as any).authManager.registerDevice('Workstation 1', 'windows', ['local:read'], 'win11-arm64-workstation');
      (doGateway as any).authManager.registerDevice('Workstation 2', 'windows', ['local:read'], 'win11-arm64-workstation-2');

      // Create pure quarantined unassigned tasks (no claimant in DB)
      await (doGateway as any).storage.saveTask({
        taskId: 'task-active-lease-conflict',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'claimed',
        priority: 0,
        payload: { path: 'active-lease.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        createdAt: now,
        updatedAt: now
      });

      await (doGateway as any).storage.saveTask({
        taskId: 'task-expired-lease-safe',
        backend: 'local',
        capability: 'local:read_file',
        requiredScope: 'local:read',
        status: 'claimed',
        priority: 0,
        payload: { path: 'expired-lease.txt' },
        retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true },
        attempts: [],
        createdAt: now - 70000,
        updatedAt: now - 10000
      });

      await (doGateway as any).initializeFromDurableStorage();

      // Ensure both tasks remain quarantined with targetDeviceId: undefined
      const taskStore = (doGateway as any).taskStore;
      const t1 = taskStore.getTask('task-active-lease-conflict');
      const t2 = taskStore.getTask('task-expired-lease-safe');
      assert.strictEqual(t1.targetDeviceId, undefined);
      assert.strictEqual(t2.targetDeviceId, undefined);

      // Set active unexpired lease on t1 (held by Workstation 1)
      t1.lease = {
        claimedBy: 'win11-arm64-workstation',
        claimedAt: now,
        leaseExpiresAt: now + 60000,
        lastHeartbeatAt: now
      };

      // Set expired lease on t2 (held by Workstation 1, expired 10s ago)
      t2.lease = {
        claimedBy: 'win11-arm64-workstation',
        claimedAt: now - 70000,
        leaseExpiresAt: now - 10000,
        lastHeartbeatAt: now - 70000
      };

      // 1. Try to reassign the active lease task to Workstation 2 -> MUST BE REJECTED/SKIPPED!
      const activeLeaseReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation-2', taskIds: ['task-active-lease-conflict'] })
      });
      const activeRes = await doGateway.fetch(activeLeaseReq);
      assert.strictEqual(activeRes.status, 200);
      const activeJson = await activeRes.json() as any;
      assert.strictEqual(activeJson.assignedCount, 0, 'Cannot reassign task with active lease held by different claimant');
      assert.deepStrictEqual(activeJson.assignedTaskIds, []);

      // Verify task-active-lease-conflict remains unassigned to Workstation 2
      assert.strictEqual(t1.targetDeviceId, undefined, 'Active lease task targetDeviceId must not be modified');
      assert.strictEqual(t1.lease?.claimedBy, 'win11-arm64-workstation');

      // 2. Try to assign the expired lease task to Workstation 2 -> SUCCEEDS!
      const expiredLeaseReq = new Request('http://localhost/admin/tasks/assign-legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testAdminSecret },
        body: JSON.stringify({ targetDeviceId: 'win11-arm64-workstation-2', taskIds: ['task-expired-lease-safe'] })
      });
      const expiredRes = await doGateway.fetch(expiredLeaseReq);
      assert.strictEqual(expiredRes.status, 200);
      const expiredJson = await expiredRes.json() as any;
      assert.strictEqual(expiredJson.assignedCount, 1, 'Expired lease task can safely be assigned');
      assert.deepStrictEqual(expiredJson.assignedTaskIds, ['task-expired-lease-safe']);

      assert.strictEqual(t2.targetDeviceId, 'win11-arm64-workstation-2');
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

if (require.main === module) {
  runMultiDeviceRoutingTests().then(res => {
    console.log(`Multi-Device Routing Tests: ${res.passed} passed, ${res.failed} failed`);
    process.exit(res.failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error('Test run failed:', err);
    process.exit(1);
  });
}
