import * as assert from 'assert';
import { CloudflareSqliteStorageAdapter, SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';
import { CloudflareR2ArtifactStorage, R2Bucket } from '../../src/cloudflare/r2-artifact-storage';
import { CloudflareKaggleHttpClient } from '../../src/kaggle/http-client';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { AuthManager } from '../../src/security/auth-manager';

// In-memory SQLite simulator for local test runner
class MockSqlStorage implements SqlStorage {
  private tables: Map<string, Map<string, any>> = new Map();

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    const q = query.trim().toUpperCase();

    if (q.startsWith('CREATE TABLE')) {
      const match = query.match(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i);
      if (match) {
        const tableName = match[1];
        if (!this.tables.has(tableName)) this.tables.set(tableName, new Map());
      }
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('INSERT') || q.startsWith('INSERT OR REPLACE')) {
      const match = query.match(/INTO\s+([a-zA-Z0-9_]+)/i);
      if (match) {
        const tableName = match[1];
        if (!this.tables.has(tableName)) this.tables.set(tableName, new Map());
        const table = this.tables.get(tableName)!;
        const key = params[0];
        table.set(String(key), params);
      }
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    if (q.startsWith('SELECT')) {
      const match = query.match(/FROM\s+([a-zA-Z0-9_]+)/i);
      if (match) {
        const tableName = match[1];
        const table = this.tables.get(tableName) || new Map();
        if (q.includes('WHERE')) {
          const key = params[0];
          const row = table.get(String(key));
          if (row && tableName === 'tasks') {
            const mapped = {
              taskId: row[0], taskKey: row[1], idempotencyKey: row[2], clientRequestId: row[3],
              backend: row[4], capability: row[5], requiredScope: row[6], status: row[7],
              priority: row[8], payloadJson: row[9], retryPolicyJson: row[10], leaseJson: row[11],
              resultJson: row[12], errorJson: row[13], artifactsJson: row[14], logsJson: row[15],
              metadataJson: row[16], startedAt: row[17], completedAt: row[18], createdAt: row[19], updatedAt: row[20]
            };
            return { one: () => mapped, toArray: () => [mapped], raw: () => row };
          }
          return { one: () => null, toArray: () => [], raw: () => null };
        }
        return { toArray: () => Array.from(table.values()), one: () => null, raw: () => [] };
      }
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
    const { token: clientToken } = authManager.generateToken('cf-client', 'client', ['admin']);

    const mockCtx: any = {
      storage: { sql: mockSql },
      getWebSockets: () => [],
      acceptWebSocket: () => {}
    };

    const durableObject = new GatewayDurableObject(mockCtx, {
      GATEWAY_DO: {},
      ARTIFACTS_R2: mockR2,
      MASTER_SECRET: testMasterSecret,
      KAGGLE_USERNAME: 'test_user',
      KAGGLE_KEY: 'test_key'
    });

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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientToken}`
      },
      body: JSON.stringify({ method: 'tools/list' })
    });
    const mcpRes = await durableObject.fetch(mcpReq);
    assert.strictEqual(mcpRes.status, 200);
    const mcpBody = await mcpRes.json() as any;
    assert.ok(mcpBody.result.tools.length >= 8);
    passed++;
  } catch (err: any) {
    console.error('Workers runtime test failed:', err);
    failed++;
  }

  return { passed, failed };
}
