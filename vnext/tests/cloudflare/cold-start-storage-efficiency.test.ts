import * as assert from 'assert';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { AuthManager } from '../../src/security/auth-manager';
import { SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';

class TrackingSqlStorage implements SqlStorage {
  queries: string[] = [];
  private taskRow: any;
  private artifactRow: any;

  constructor() {
    const now = Date.now();
    this.taskRow = {
      taskId: 'task-historical-01', taskKey: null, idempotencyKey: null, clientRequestId: null,
      backend: 'local', capability: 'local:read_file', requiredScope: 'local:read', status: 'succeeded',
      priority: 0, payloadJson: JSON.stringify({ projectId: 'demo', relativePath: 'README.md' }),
      retryPolicyJson: JSON.stringify({ maxRetries: 3, retryCount: 0, backoffMs: 2000, requeueOnStale: true }),
      leaseJson: null, resultJson: JSON.stringify({ content: 'historical-result' }), errorJson: null,
      artifactsJson: JSON.stringify([{ id: 'art-historical-01', name: 'result.txt', type: 'log', sizeBytes: 17, mimeType: 'text/plain' }]),
      logsJson: JSON.stringify(['historical-log']), metadataJson: null,
      startedAt: now - 2000, completedAt: now - 1000, createdAt: now - 3000, updatedAt: now - 1000
    };
    this.artifactRow = {
      id: 'art-historical-01', taskId: 'task-historical-01', name: 'result.txt', type: 'log',
      sizeBytes: 17, sha256: 'a'.repeat(64), mimeType: 'text/plain', preview: 'historical-result', createdAt: now - 900
    };
  }

  exec(query: string, ...params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    this.queries.push(query.replace(/\s+/g, ' ').trim());
    const q = query.replace(/\s+/g, ' ').trim().toUpperCase();

    if (q.startsWith('CREATE ') || q.startsWith('ALTER ')) {
      return { toArray: () => [], one: () => null, raw: () => [] };
    }

    let rows: any[] = [];
    if (q.includes('FROM TASKS')) {
      if (/WHERE TASKID\s*=\s*\?/i.test(query)) {
        rows = String(params[0]) === this.taskRow.taskId ? [this.taskRow] : [];
      } else if (/STATUS\s+IN/i.test(query)) {
        rows = []; // historical succeeded task must not be part of active hydration
      } else {
        rows = [this.taskRow];
      }
    } else if (q.includes('FROM ARTIFACTS')) {
      if (/WHERE ID\s*=\s*\?/i.test(query)) {
        rows = String(params[0]) === this.artifactRow.id ? [this.artifactRow] : [];
      } else if (/WHERE TASKID\s*=\s*\?/i.test(query)) {
        rows = String(params[0]) === this.artifactRow.taskId ? [this.artifactRow] : [];
      } else {
        rows = [this.artifactRow];
      }
    } else if (q.includes('FROM REVOKED_TOKENS')) {
      rows = [];
    } else if (q.includes('FROM KILL_SWITCH_STATE') || q.includes('FROM R2_USAGE_ACCOUNTING')) {
      rows = [];
    }

    return { toArray: () => rows, one: () => rows[0] || null, raw: () => rows[0] || null };
  }
}

function createContext(sql: SqlStorage) {
  const kv = new Map<string, any>();
  return {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: any) => { kv.set(key, structuredClone(value)); },
      setAlarm: async (_when: number) => {},
      deleteAlarm: async () => {}
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); }
  };
}

async function callTool(gateway: GatewayDurableObject, token: string, name: string, args: any): Promise<any> {
  const response = await gateway.fetch(new Request('https://gateway.workers.dev/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  }));
  assert.strictEqual(response.status, 200);
  const body = await response.json() as any;
  const result = JSON.parse(body.result.content[0].text);
  if (body.result.isError) throw new Error(result.error || `${name} failed`);
  return result;
}

export async function runColdStartStorageEfficiencyTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); passed++; }
    catch (err: any) { failed++; console.error(`Cold-start storage efficiency failed (${name}):`, err); }
  };

  const masterSecret = 'cold-start-storage-efficiency-master-secret-32-bytes';
  const authManager = new AuthManager(masterSecret);
  const token = authManager.generateToken('cold-start-client', 'client', ['mcp:access', 'tasks:read', 'artifacts:read']).token;

  await run('constructor hydrates only active tasks and does not preload all artifacts', async () => {
    const sql = new TrackingSqlStorage();
    const gateway = new GatewayDurableObject(createContext(sql), { GATEWAY_DO: {}, MASTER_SECRET: masterSecret });
    await (gateway as any).ready;

    const taskQueries = sql.queries.filter(q => /FROM tasks/i.test(q));
    const artifactQueries = sql.queries.filter(q => /FROM artifacts/i.test(q));
    assert.ok(taskQueries.some(q => /STATUS\s+IN/i.test(q)), `cold start must query only active task statuses; got: ${taskQueries.join(' | ')}`);
    assert.strictEqual(taskQueries.some(q => /WHERE\s+1\s*=\s*1/i.test(q)), false, 'cold start must not scan all historical tasks');
    assert.strictEqual(artifactQueries.length, 0, `cold start must not preload all artifact metadata; got: ${artifactQueries.join(' | ')}`);
  });

  await run('historical completed task remains readable through durable point lookup after lean hydration', async () => {
    const sql = new TrackingSqlStorage();
    const gateway = new GatewayDurableObject(createContext(sql), { GATEWAY_DO: {}, MASTER_SECRET: masterSecret });
    await (gateway as any).ready;
    const result = await callTool(gateway, token, 'remote_task_status', { taskId: 'task-historical-01' });
    assert.strictEqual(result.status, 'succeeded');
    assert.deepStrictEqual(result.result, { content: 'historical-result' });
    assert.ok(sql.queries.some(q => /FROM tasks WHERE taskId\s*=\s*\?/i.test(q)), 'historical task must use taskId point lookup');
  });

  await run('historical task artifacts remain readable through indexed taskId lookup after lean hydration', async () => {
    const sql = new TrackingSqlStorage();
    const gateway = new GatewayDurableObject(createContext(sql), { GATEWAY_DO: {}, MASTER_SECRET: masterSecret });
    await (gateway as any).ready;
    const result = await callTool(gateway, token, 'remote_task_artifacts', { taskId: 'task-historical-01' });
    assert.strictEqual(result.artifactsCount, 1);
    assert.strictEqual(result.artifacts[0].id, 'art-historical-01');
    assert.ok(sql.queries.some(q => /FROM artifacts WHERE taskId\s*=\s*\?/i.test(q)), 'historical artifacts must use taskId lookup');
  });

  return { passed, failed };
}
