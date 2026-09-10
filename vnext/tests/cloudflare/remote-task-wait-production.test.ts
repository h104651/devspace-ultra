import * as assert from 'assert';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { AuthManager } from '../../src/security/auth-manager';

function createEmptySql() {
  const empty = { toArray: () => [], one: () => null, raw: () => null };
  return { exec: () => empty };
}

function createMockCtx() {
  const kv = new Map<string, any>();
  return {
    storage: {
      sql: createEmptySql(),
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: any) => { kv.set(key, structuredClone(value)); },
      setAlarm: async () => {},
      deleteAlarm: async () => {}
    },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); }
  };
}

export async function runRemoteTaskWaitProductionTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const masterSecret = 'remote-task-wait-production-test-secret-1234567890';
    const auth = new AuthManager(masterSecret);
    const { token } = auth.generateToken('wait-client', 'client', ['mcp:access', 'tasks:read']);
    const durableObject = new GatewayDurableObject(createMockCtx(), {
      GATEWAY_DO: {},
      MASTER_SECRET: masterSecret
    });

    const listResponse = await durableObject.fetch(new Request('https://gateway.workers.dev/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }));
    assert.strictEqual(listResponse.status, 200);
    const listBody = await listResponse.json() as any;
    const toolNames = listBody.result.tools.map((tool: any) => tool.name);
    assert.ok(toolNames.includes('remote_task_wait'), 'Production Cloudflare MCP tools/list must expose remote_task_wait');
    passed++;

    const callResponse = await durableObject.fetch(new Request('https://gateway.workers.dev/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'remote_task_wait',
          arguments: { taskId: 'missing-task', timeoutMs: 0 }
        }
      })
    }));
    assert.strictEqual(callResponse.status, 200, 'Known production tool must route through MCP instead of returning tool-not-found');
    const callBody = await callResponse.json() as any;
    assert.strictEqual(callBody.result.isError, true);
    assert.ok(callBody.result.content[0].text.includes('TASK_NOT_FOUND: missing-task'));
    passed++;
  } catch (err: any) {
    failed++;
    console.error(`\n  FAIL: Cloudflare production remote_task_wait surface\n  ${err.stack || err.message}`);
  }

  return { passed, failed };
}
