import * as assert from 'assert';
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';
import { CloudflareR2ArtifactStorage, R2Bucket } from '../../src/cloudflare/r2-artifact-storage';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { AuthManager } from '../../src/security/auth-manager';

class MockSqlStorage implements SqlStorage {
  private tables: Map<string, Map<string, any>> = new Map();

  private mapTask(row: any[]) {
    return {
      taskId: row[0], taskKey: row[1], idempotencyKey: row[2], clientRequestId: row[3],
      backend: row[4], capability: row[5], requiredScope: row[6], status: row[7],
      priority: row[8], payloadJson: row[9], retryPolicyJson: row[10], leaseJson: row[11],
      resultJson: row[12], errorJson: row[13], artifactsJson: row[14], logsJson: row[15],
      metadataJson: row[16], startedAt: row[17], completedAt: row[18], createdAt: row[19], updatedAt: row[20]
    };
  }

  private mapArtifact(row: any[]) {
    return {
      id: row[0], taskId: row[1], name: row[2], type: row[3], sizeBytes: row[4],
      sha256: row[5], mimeType: row[6], preview: row[7], createdAt: row[8]
    };
  }

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const q = query.trim().toUpperCase();

    if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX') || q.startsWith('ALTER TABLE')) {
      const match = query.match(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i);
      if (match && !this.tables.has(match[1])) this.tables.set(match[1], new Map());
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('INSERT') || q.startsWith('INSERT OR REPLACE')) {
      const match = query.match(/INTO\s+([a-zA-Z0-9_]+)/i);
      if (match) {
        const tableName = match[1];
        if (!this.tables.has(tableName)) this.tables.set(tableName, new Map());
        this.tables.get(tableName)!.set(String(params[0]), params);
      }
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('DELETE')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (match) this.tables.get(match[1])?.delete(String(params[0]));
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('SELECT')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (!match) return { toArray: () => [], one: () => null, raw: () => [] };
      const tableName = match[1];
      const table = this.tables.get(tableName) || new Map();
      const allRows = Array.from(table.values());
      let selected = allRows;

      if (tableName === 'tasks') {
        if (/WHERE\s+TASKID\s*=\s*\?/i.test(query)) selected = allRows.filter(r => String(r[0]) === String(params[0]));
        const mapped = selected.map(r => this.mapTask(r));
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => selected[0] || null };
      }

      if (tableName === 'artifacts') {
        if (/WHERE\s+ID\s*=\s*\?/i.test(query)) selected = allRows.filter(r => String(r[0]) === String(params[0]));
        if (/WHERE\s+TASKID\s*=\s*\?/i.test(query)) selected = allRows.filter(r => String(r[1]) === String(params[0]));
        const mapped = selected.map(r => this.mapArtifact(r));
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => selected[0] || null };
      }

      if (tableName === 'kill_switch_state') {
        const row = table.get(String(params[0])) || allRows[0];
        const mapped = row ? [{ id: row[0], stateJson: row[1], updatedAt: row[2] }] : [];
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped[0] || null };
      }

      if (tableName === 'r2_usage_accounting') {
        const row = table.get(String(params[0])) || allRows[0];
        const mapped = row ? [{ id: row[0], monthKey: row[1], storedBytes: row[2], objectCount: row[3], classAOperations: row[4], classBOperations: row[5], updatedAt: row[6] }] : [];
        return { toArray: () => mapped, one: () => mapped[0] || null, raw: () => mapped[0] || null };
      }

      if (q.includes('WHERE') && params.length > 0) {
        const row = table.get(String(params[0]));
        selected = row ? [row] : [];
      }
      return { toArray: () => selected, one: () => selected[0] || null, raw: () => selected[0] || null };
    }

    return { toArray: () => [], one: () => null, raw: () => null };
  }
}

class MockR2Bucket implements R2Bucket {
  public objects: Map<string, Uint8Array> = new Map();

  async put(key: string, value: any): Promise<any> {
    const buf = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
    this.objects.set(key, buf);
    return { key, size: buf.byteLength };
  }

  async get(key: string): Promise<any> {
    const data = this.objects.get(key);
    if (!data) return null;
    return { arrayBuffer: async () => data.buffer };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export async function runWorkersRuntimeTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const mockSql = new MockSqlStorage();
    const storage = new CloudflareSqliteStorageAdapter(mockSql);

    const task = {
      taskId: 'task-workers-01',
      backend: 'kaggle' as const,
      capability: 'kaggle:run',
      requiredScope: 'kaggle:submit',
      status: 'queued' as const,
      priority: 10,
      payload: { kernelSlug: 'test-do-task' },
      retryPolicy: { maxRetries: 3, retryCount: 0, backoffMs: 1000, requeueOnStale: true },
      artifacts: [],
      logs: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await storage.saveTask(task);
    const reloaded = await storage.getTask('task-workers-01');
    assert.strictEqual(reloaded?.taskId, 'task-workers-01');
    assert.strictEqual(reloaded?.capability, 'kaggle:run');
    passed++;

    const mockR2 = new MockR2Bucket();
    const r2Storage = new CloudflareR2ArtifactStorage(mockR2);

    const smallArt = await r2Storage.saveArtifact('task-1', 'small.log', 'Log line 1\nLog line 2', 'log');
    assert.strictEqual(smallArt.metadata.name, 'small.log');
    assert.strictEqual(smallArt.metadata.preview, 'Log line 1\nLog line 2');
    assert.strictEqual(smallArt.r2Key, undefined, 'Small artifact should not use R2');
    passed++;

    const bigContent = new Uint8Array(300 * 1024);
    const bigArt = await r2Storage.saveArtifact('task-1', 'weights.pt', bigContent, 'binary');
    assert.ok(bigArt.r2Key, 'Large artifact must be stored in R2');
    assert.strictEqual(mockR2.objects.has(bigArt.r2Key!), true);
    passed++;

    const kaggleClient = new CloudflareKaggleHttpClient({ isMockMode: true });
    assert.strictEqual(kaggleClient.getUsername(), 'kaggle_user');
    const pushRes = await kaggleClient.pushKernel({ kernelSlug: 'test-http-push', code: 'print(1)' });
    assert.strictEqual(pushRes.success, true);
    assert.ok(pushRes.kernelUrl.includes('test-http-push'));
    const statusRes = await kaggleClient.getKernelStatus('test-http-push');
    assert.strictEqual(statusRes.status, 'complete');
    const outputRes = await kaggleClient.downloadKernelOutput('test-http-push');
    assert.strictEqual(outputRes.success, true);
    assert.strictEqual(outputRes.files.length, 2);
    passed++;

    const testMasterSecret = 'test-workers-secret-32-bytes-minimum-1234567890';
    const authManager = new AuthManager(testMasterSecret);
    const { token: clientToken } = authManager.generateToken('cf-client', 'client', ['mcp:access', 'tasks:submit', 'tasks:read', 'kaggle:submit', 'kaggle:read', 'local:read', 'local:test']);
    const kv = new Map<string, any>();
    let alarmAt: number | null = null;

    const createMockCtx = () => ({
      storage: {
        sql: mockSql,
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: any) => { kv.set(key, structuredClone(value)); },
        setAlarm: async (when: number) => { alarmAt = when; },
        deleteAlarm: async () => { alarmAt = null; }
      },
      getWebSockets: () => [],
      acceptWebSocket: () => {},
      blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); }
    });

    const durableEnv = {
      GATEWAY_DO: {},
      ARTIFACTS_R2: mockR2,
      MASTER_SECRET: testMasterSecret
      // No Kaggle credentials: CloudflareKaggleHttpClient intentionally runs in mock mode.
    };

    const durableObject = new GatewayDurableObject(createMockCtx(), durableEnv);

    const healthReq = new Request('https://gateway.workers.dev/health');
    const healthRes = await durableObject.fetch(healthReq);
    assert.strictEqual(healthRes.status, 200);
    const healthBody = await healthRes.json() as any;
    assert.strictEqual(healthBody.ok, true);
    assert.strictEqual(healthBody.runtime, undefined);
    passed++;

    const adminToken = authManager.generateToken('admin-tester', 'client', ['admin:health']).token;
    const adminReq = new Request('https://gateway.workers.dev/admin/health', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const adminRes = await durableObject.fetch(adminReq);
    assert.strictEqual(adminRes.status, 200);
    const adminBody = await adminRes.json() as any;
    assert.strictEqual(adminBody.runtime, 'cloudflare-durable-objects-sqlite');
    assert.strictEqual(adminBody.r2Available, true);
    passed++;

    const mcpReq = new Request('https://gateway.workers.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({ method: 'tools/list' })
    });
    const mcpRes = await durableObject.fetch(mcpReq);
    assert.strictEqual(mcpRes.status, 200);
    const mcpBody = await mcpRes.json() as any;
    assert.ok(mcpBody.result.tools.length >= 8);
    passed++;

    // 5. Durable Kaggle polling survives a Durable Object instance replacement.
    const runReq = new Request('https://gateway.workers.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 41, method: 'tools/call',
        params: { name: 'kaggle_run', arguments: { kernelSlug: 'durable-alarm-smoke', code: 'print("durable")' } }
      })
    });
    const runRes = await durableObject.fetch(runReq);
    assert.strictEqual(runRes.status, 200);
    const runBody = await runRes.json() as any;
    const runResult = JSON.parse(runBody.result.content[0].text);
    assert.ok(runResult.taskId);
    assert.ok(alarmAt, 'Kaggle submission must arm a Durable Object alarm');

    const pollKey = 'devspace:kaggle-polls:v1';
    const pending = kv.get(pollKey);
    assert.ok(pending?.[runResult.taskId], 'Pending Kaggle poll must be persisted in Durable Object storage');
    pending[runResult.taskId].dueAt = Date.now() - 1;
    kv.set(pollKey, pending);

    // Simulate eviction/restart: a fresh instance hydrates the task from SQLite and
    // consumes the same durable alarm/poll record.
    const replacement = new GatewayDurableObject(createMockCtx(), durableEnv);
    await replacement.alarm();

    const statusReq = new Request('https://gateway.workers.dev/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'kaggle_status', arguments: { taskId: runResult.taskId } }
      })
    });
    const statusAfterAlarm = await replacement.fetch(statusReq);
    assert.strictEqual(statusAfterAlarm.status, 200);
    const statusBody = await statusAfterAlarm.json() as any;
    const statusResultAfterAlarm = JSON.parse(statusBody.result.content[0].text);
    assert.strictEqual(statusResultAfterAlarm.status, 'succeeded');
    assert.strictEqual(kv.get(pollKey)?.[runResult.taskId], undefined, 'Terminal Kaggle task must be removed from pending alarm state');
    passed++;

    // 6. Durable Kill Switch survives DO instance replacement / restart
    (durableObject as any).killSwitch.triggerGlobalEmergencyStop('Production incident simulation');
    assert.strictEqual((durableObject as any).killSwitch.getState().globalEmergencyStop, true);

    const deniedSubmitReq = new Request('https://gateway.workers.dev/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({
        backend: 'kaggle',
        capability: 'kaggle:run',
        payload: { kernelSlug: 'blocked-by-ks' }
      })
    });
    const deniedSubmitRes = await durableObject.fetch(deniedSubmitReq);
    assert.strictEqual(deniedSubmitRes.status, 400);
    const deniedBody = await deniedSubmitRes.json() as any;
    assert.ok(deniedBody.error.includes('EMERGENCY_DENY_ALL'), 'Submission must be blocked when emergency stop is active');

    // Recreate DO instance (simulate restart) and verify emergency stop is hydrated
    const restartedDo = new GatewayDurableObject(createMockCtx(), durableEnv);
    await (restartedDo as any).ready;
    assert.strictEqual((restartedDo as any).killSwitch.getState().globalEmergencyStop, true, 'Emergency stop state must persist across restarts');

    const deniedSubmitReq2 = new Request('https://gateway.workers.dev/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({
        backend: 'kaggle',
        capability: 'kaggle:run',
        payload: { kernelSlug: 'blocked-by-ks' }
      })
    });
    const deniedAfterRestartRes = await restartedDo.fetch(deniedSubmitReq2);
    assert.strictEqual(deniedAfterRestartRes.status, 400);

    // Test device and client revocation across restart
    (restartedDo as any).killSwitch.resetGlobalEmergencyStop();
    (restartedDo as any).killSwitch.revokeDevice('rogue-device-01', 'Security audit failure');
    (restartedDo as any).killSwitch.revokeClient('compromised-client-02', 'Leaked token');

    const restartedDo2 = new GatewayDurableObject(createMockCtx(), durableEnv);
    await (restartedDo2 as any).ready;
    assert.strictEqual((restartedDo2 as any).killSwitch.getState().globalEmergencyStop, false);
    assert.strictEqual((restartedDo2 as any).killSwitch.isDeviceRevoked('rogue-device-01'), true, 'Revoked device must persist across restarts');
    assert.strictEqual((restartedDo2 as any).killSwitch.isClientRevoked('compromised-client-02'), true, 'Revoked client must persist across restarts');
    passed++;

    // 7. Sanitized HTTP 500 Responses: never leaks internal errors/secrets in response body
    const fakeSecret = 'SUPER_SECRET_INTERNAL_VALUE_DO_NOT_LEAK';
    const origMethod = (durableObject as any).taskRouter.routeTaskSubmit;
    (durableObject as any).taskRouter.routeTaskSubmit = async () => {
      throw new Error(`Database connection failed: user=admin secret=${fakeSecret} path=/var/internal/secrets`);
    };

    const crashReq = new Request('https://gateway.workers.dev/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({ backend: 'kaggle', capability: 'kaggle:run', payload: {} })
    });
    const crashRes = await durableObject.fetch(crashReq);
    (durableObject as any).taskRouter.routeTaskSubmit = origMethod; // restore

    assert.strictEqual(crashRes.status, 500);
    const crashJson = await crashRes.json() as any;
    assert.strictEqual(crashJson.error, 'INTERNAL_ERROR');
    assert.strictEqual(crashJson.message, undefined, 'Internal exception message must NOT be in HTTP response');
    const fullResponseText = JSON.stringify(crashJson);
    assert.ok(!fullResponseText.includes(fakeSecret), 'Secret must NEVER be present in HTTP 500 response body');
    passed++;

    // 8. Kill Switch Endpoint Authorization: Normal OAuth client rejected (403), Independent Admin allowed (200)
    const normalKsReq = new Request('https://gateway.workers.dev/admin/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${clientToken}` },
      body: JSON.stringify({ action: 'EMERGENCY_STOP' })
    });
    const normalKsRes = await durableObject.fetch(normalKsReq);
    assert.strictEqual(normalKsRes.status, 403, 'Normal ChatGPT OAuth token must be rejected from admin kill switch');

    const adminKsReq = new Request('https://gateway.workers.dev/admin/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testMasterSecret },
      body: JSON.stringify({ action: 'EMERGENCY_STOP', reason: 'Admin unit test' })
    });
    const adminKsRes = await durableObject.fetch(adminKsReq);
    assert.strictEqual(adminKsRes.status, 200, 'Independent admin credential must be allowed to execute Kill Switch');
    const adminKsJson = await adminKsRes.json() as any;
    assert.strictEqual(adminKsJson.ok, true);

    // Clear stop with admin credential
    const clearKsReq = new Request('https://gateway.workers.dev/admin/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': testMasterSecret },
      body: JSON.stringify({ action: 'CLEAR_STOP' })
    });
    const clearKsRes = await durableObject.fetch(clearKsReq);
    assert.strictEqual(clearKsRes.status, 200);
    passed++;
  } catch (err: any) {
    console.error('Workers runtime test failed:', err);
    failed++;
  }

  return { passed, failed };
}
