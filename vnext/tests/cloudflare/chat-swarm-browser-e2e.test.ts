import * as assert from 'assert';
import { GatewayDurableObject } from '../../src/cloudflare/gateway-durable-object';
import { AuthManager } from '../../src/security/auth-manager';
import { SqlStorage } from '../../src/cloudflare/sqlite-storage-adapter';

class EmptySqlStorage implements SqlStorage {
  exec(_query: string, ..._params: any[]): { toArray(): any[]; one(): any; raw(): any } {
    return { toArray: () => [], one: () => null, raw: () => null };
  }
}

function createContext(sql: SqlStorage, kv: Map<string, any>) {
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

async function callTool(
  gateway: GatewayDurableObject,
  token: string,
  name: string,
  args: any,
  id = 1
): Promise<any> {
  const response = await gateway.fetch(new Request('https://gateway.workers.dev/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  }));
  assert.strictEqual(response.status, 200, `${name} should return HTTP 200`);
  const body = await response.json() as any;
  assert.ok(body.result?.content?.[0]?.text, `${name} should return MCP text content`);
  const result = JSON.parse(body.result.content[0].text);
  if (body.result.isError) throw new Error(result.error || `${name} failed`);
  return result;
}

async function directBrowserJoin(gateway: GatewayDurableObject, inviteCode: string, pageKey: string, label: string) {
  const response = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/browser-direct-join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode, pageKey, label })
  }));
  assert.strictEqual(response.status, 200, 'browser direct join should succeed');
  return await response.json() as any;
}

async function readFirstSseEvent(response: Response): Promise<any> {
  assert.strictEqual(response.status, 200);
  assert.ok((response.headers.get('Content-Type') || '').includes('text/event-stream'));
  assert.ok(response.body, 'SSE response must expose a readable body');

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (let i = 0; i < 10; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const blockEnd = buffer.indexOf('\n\n');
      if (blockEnd < 0) continue;
      const block = buffer.slice(0, blockEnd);
      const dataLine = block.split('\n').find(line => line.startsWith('data:'));
      if (!dataLine) continue;
      return JSON.parse(dataLine.slice(5).trim());
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  throw new Error(`No SSE data event received. Buffer: ${buffer.slice(0, 300)}`);
}

async function browserEvent(gateway: GatewayDurableObject, browserWakeToken: string): Promise<any> {
  const response = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/browser-events', {
    method: 'GET',
    headers: { 'X-Chat-Swarm-Browser-Token': browserWakeToken }
  }));
  return readFirstSseEvent(response);
}

async function browserClaim(gateway: GatewayDurableObject, browserWakeToken: string): Promise<any> {
  const response = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/browser-claim', {
    method: 'POST',
    headers: { 'X-Chat-Swarm-Browser-Token': browserWakeToken }
  }));
  assert.strictEqual(response.status, 200, 'browser claim should succeed');
  return await response.json() as any;
}

async function workerEvent(gateway: GatewayDurableObject, workerToken: string): Promise<any> {
  const response = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/worker-events', {
    method: 'GET',
    headers: { 'X-Chat-Swarm-Worker-Token': workerToken }
  }));
  return readFirstSseEvent(response);
}

export async function runChatSwarmBrowserE2ETests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      failed++;
      console.error(`Cloudflare Browser Swarm E2E failed (${name}):`, err);
    }
  };

  const masterSecret = 'browser-swarm-e2e-master-secret-32-bytes-minimum-12345';
  const sql = new EmptySqlStorage();
  const kv = new Map<string, any>();
  const env = { GATEWAY_DO: {}, MASTER_SECRET: masterSecret };
  const authManager = new AuthManager(masterSecret);
  const clientToken = authManager.generateToken(
    'browser-swarm-e2e-client',
    'client',
    ['mcp:access', 'swarm:dispatch']
  ).token;

  const createGateway = () => new GatewayDurableObject(createContext(sql, kv), env);
  let gateway = createGateway();

  let swarm: any;
  let browserA: any;
  let browserB: any;
  let taskId = '';

  await run('direct browser join is idempotent per page key', async () => {
    swarm = await callTool(gateway, clientToken, 'chat_swarm_create', { name: 'Browser E2E', workerSlots: 2 }, 100);
    assert.ok(swarm.inviteCode);
    assert.ok(swarm.orchestratorToken);

    const first = await directBrowserJoin(gateway, swarm.inviteCode, 'page-A-stable-key', 'Browser-A');
    const second = await directBrowserJoin(gateway, swarm.inviteCode, 'page-A-stable-key', 'Browser-A');
    assert.strictEqual(second.workerId, first.workerId, 'same browser page must reuse its worker slot');
    assert.notStrictEqual(second.workerToken, first.workerToken, 'reconnect should rotate the private worker token');
    browserA = second;

    browserB = await directBrowserJoin(gateway, swarm.inviteCode, 'page-B-stable-key', 'Browser-B');
    assert.notStrictEqual(browserB.workerId, browserA.workerId);

    const status = await callTool(gateway, clientToken, 'chat_swarm_status', { token: swarm.orchestratorToken }, 101);
    assert.strictEqual(status.activeWorkers, 2, 'reconnecting page A must not consume a third slot');
  });

  await run('generic task is offered to only one browser worker', async () => {
    const dispatched = await callTool(gateway, clientToken, 'chat_swarm_dispatch', {
      orchestratorToken: swarm.orchestratorToken,
      tasks: [{ taskKey: 'browser-generic-1', prompt: 'Return browser-e2e-ok' }]
    }, 102);
    taskId = dispatched.tasks[0].taskId;
    assert.ok(taskId);

    const eventA = await browserEvent(gateway, browserA.browserWakeToken);
    assert.strictEqual(eventA.type, 'task_available');
    assert.strictEqual(eventA.taskId, taskId);

    const eventB = await browserEvent(gateway, browserB.browserWakeToken);
    assert.strictEqual(eventB.type, 'parked', 'offer lease should prevent duplicate wake of generic work');
  });

  await run('claimed browser task survives Durable Object replacement and submits once', async () => {
    const claimed = await browserClaim(gateway, browserA.browserWakeToken);
    assert.strictEqual(claimed.state, 'task');
    assert.strictEqual(claimed.task.taskId, taskId);

    const workerStatus = await callTool(gateway, clientToken, 'chat_swarm_status', { token: browserA.workerToken }, 103);
    assert.strictEqual(workerStatus.workerId, browserA.workerId);

    gateway = createGateway();

    const replay = await browserClaim(gateway, browserA.browserWakeToken);
    assert.strictEqual(replay.state, 'task');
    assert.strictEqual(replay.task.taskId, taskId);
    assert.strictEqual(replay.replay, true, 'claimed task must replay to the same browser after restart');

    const submitted = await callTool(gateway, clientToken, 'chat_swarm_submit_once', {
      workerToken: browserA.workerToken,
      taskId,
      status: 'completed',
      result: 'browser-e2e-ok'
    }, 104);
    assert.strictEqual(submitted.ok, true);
    assert.strictEqual(submitted.submitted.taskId, taskId);

    const collected = await callTool(gateway, clientToken, 'chat_swarm_collect', {
      orchestratorToken: swarm.orchestratorToken,
      taskIds: [taskId],
      waitFor: 'all',
      waitMs: 0
    }, 105);
    assert.strictEqual(collected.tasks[0].status, 'completed');
    assert.strictEqual(collected.tasks[0].result, 'browser-e2e-ok');

    const status = await callTool(gateway, clientToken, 'chat_swarm_status', { token: swarm.orchestratorToken }, 106);
    assert.strictEqual(status.activeWorkers, 2);
    assert.strictEqual(status.taskCounts.completed, 1);
  });

  await run('one-time browser bind path works and invalid browser tokens are rejected', async () => {
    const secondSwarm = await callTool(gateway, clientToken, 'chat_swarm_create', { name: 'Bind E2E', workerSlots: 1 }, 107);
    const joinedBrowser = await callTool(gateway, clientToken, 'chat_swarm_join_browser', {
      inviteCode: secondSwarm.inviteCode,
      label: 'Bound-Browser'
    }, 108);
    assert.ok(joinedBrowser.browserBindCode);

    const bindResponse = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/browser-bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: joinedBrowser.browserBindCode })
    }));
    assert.strictEqual(bindResponse.status, 200);
    const bound = await bindResponse.json() as any;
    assert.strictEqual(bound.workerId, joinedBrowser.workerId);
    assert.ok(bound.browserWakeToken);

    const invalid = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/browser-claim', {
      method: 'POST',
      headers: { 'X-Chat-Swarm-Browser-Token': 'not-a-valid-browser-token' }
    }));
    assert.strictEqual(invalid.status, 401);
  });

  await run('Worker Dock stream reserves one task and chat_swarm_submit re-parks onto the next task', async () => {
    const dockSwarm = await callTool(gateway, clientToken, 'chat_swarm_create', { name: 'Worker Dock E2E', workerSlots: 1 }, 200);
    const worker = await callTool(gateway, clientToken, 'chat_swarm_join', {
      inviteCode: dockSwarm.inviteCode,
      label: 'Dock-Worker'
    }, 201);
    const dock = await callTool(gateway, clientToken, 'chat_swarm_dock', { workerToken: worker.workerToken }, 202);
    assert.strictEqual(dock.workerDock, true);
    assert.strictEqual(dock.workerToken, worker.workerToken);
    assert.ok(dock.dockStreamUrl.endsWith('/chat-swarm/worker-events'));
    assert.strictEqual(dock.browserBindCode, undefined, 'Worker Dock must not masquerade as browser binding');

    const dispatched = await callTool(gateway, clientToken, 'chat_swarm_dispatch', {
      orchestratorToken: dockSwarm.orchestratorToken,
      tasks: [
        { taskKey: 'dock-1', prompt: 'first dock task', targetWorkerId: worker.workerId },
        { taskKey: 'dock-2', prompt: 'second dock task', targetWorkerId: worker.workerId }
      ]
    }, 203);
    const firstTaskId = dispatched.tasks[0].taskId;
    const secondTaskId = dispatched.tasks[1].taskId;

    const event = await workerEvent(gateway, worker.workerToken);
    assert.strictEqual(event.type, 'task_available');
    assert.strictEqual(event.taskId, firstTaskId);

    const claimed = await callTool(gateway, clientToken, 'chat_swarm_claim', { workerToken: worker.workerToken }, 204);
    assert.strictEqual(claimed.state, 'task');
    assert.strictEqual(claimed.task.taskId, firstTaskId);
    await callTool(gateway, clientToken, 'chat_swarm_ack', { workerToken: worker.workerToken, taskId: firstTaskId }, 205);

    const submittedAndReparked = await callTool(gateway, clientToken, 'chat_swarm_submit', {
      workerToken: worker.workerToken,
      taskId: firstTaskId,
      status: 'completed',
      result: 'first-complete'
    }, 206);
    assert.strictEqual(submittedAndReparked.submitted.taskId, firstTaskId);
    assert.strictEqual(submittedAndReparked.next.state, 'task', 'submit must immediately re-enter the worker loop');
    assert.strictEqual(submittedAndReparked.next.task.taskId, secondTaskId);

    await callTool(gateway, clientToken, 'chat_swarm_ack', { workerToken: worker.workerToken, taskId: secondTaskId }, 207);
    await callTool(gateway, clientToken, 'chat_swarm_submit_once', {
      workerToken: worker.workerToken,
      taskId: secondTaskId,
      status: 'completed',
      result: 'second-complete'
    }, 208);

    const collected = await callTool(gateway, clientToken, 'chat_swarm_collect', {
      orchestratorToken: dockSwarm.orchestratorToken,
      taskIds: [firstTaskId, secondTaskId],
      waitFor: 'all',
      waitMs: 0
    }, 209);
    assert.strictEqual(collected.complete, true);
    assert.deepStrictEqual(collected.tasks.map((item: any) => item.result), ['first-complete', 'second-complete']);

    const invalidWorkerStream = await gateway.fetch(new Request('https://gateway.workers.dev/chat-swarm/worker-events', {
      method: 'GET',
      headers: { 'X-Chat-Swarm-Worker-Token': 'not-a-valid-worker-token' }
    }));
    assert.strictEqual(invalidWorkerStream.status, 401);
  });

  return { passed, failed };
}
