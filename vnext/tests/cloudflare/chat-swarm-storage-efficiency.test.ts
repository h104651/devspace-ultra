import * as assert from 'assert';
import { DurableChatSwarmCompat } from '../../src/swarm/chat-swarm-compat';

class CountingStorage {
  private data = new Map<string, any>();
  gets = 0;
  puts = 0;

  async get(key: string): Promise<any> {
    this.gets++;
    const value = this.data.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key: string, value: any): Promise<void> {
    this.puts++;
    this.data.set(key, structuredClone(value));
  }
}

export async function runChatSwarmStorageEfficiencyTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
    } catch (err: any) {
      failed++;
      console.error(`Chat Swarm storage efficiency failed (${name}):`, err);
    }
  };

  await run('parked browser events do not read or persist durable state on every 1.5s poll', async () => {
    const storage = new CountingStorage();
    const compat = new DurableChatSwarmCompat(storage);
    const swarm = await compat.create({ name: 'storage-efficiency-browser', workerSlots: 1 });
    const browser = await compat.joinBrowserDirect({ inviteCode: swarm.inviteCode, label: 'Browser', pageKey: 'stable-page' });
    const baselineGets = storage.gets;
    const baselinePuts = storage.puts;

    for (let i = 0; i < 4; i++) {
      const event = await compat.browserEvent(browser.browserWakeToken);
      assert.strictEqual(event.type, 'parked');
    }

    assert.strictEqual(storage.gets, baselineGets, 'idle browser polling should use instance memory after initial state load');
    assert.strictEqual(storage.puts, baselinePuts, 'idle browser polling should not persist heartbeat-only state');
  });

  await run('parked Worker Dock events do not read or persist durable state on every poll', async () => {
    const storage = new CountingStorage();
    const compat = new DurableChatSwarmCompat(storage);
    const swarm = await compat.create({ name: 'storage-efficiency-dock', workerSlots: 1 });
    const worker = await compat.join({ inviteCode: swarm.inviteCode, label: 'Dock' });
    const baselineGets = storage.gets;
    const baselinePuts = storage.puts;

    for (let i = 0; i < 4; i++) {
      const event = await compat.workerEvent(worker.workerToken);
      assert.strictEqual(event.type, 'parked');
    }

    assert.strictEqual(storage.gets, baselineGets, 'idle dock polling should use instance memory after initial state load');
    assert.strictEqual(storage.puts, baselinePuts, 'idle dock polling should not persist heartbeat-only state');
  });

  await run('idle chat_swarm_next checkpoint does not rewrite durable state once per second', async () => {
    const storage = new CountingStorage();
    const compat = new DurableChatSwarmCompat(storage);
    const swarm = await compat.create({ name: 'storage-efficiency-next', workerSlots: 1 });
    const worker = await compat.join({ inviteCode: swarm.inviteCode, label: 'Next' });
    const baselineGets = storage.gets;
    const baselinePuts = storage.puts;

    const result = await compat.next({ workerToken: worker.workerToken, waitMs: 10 });
    assert.strictEqual(result.state, 'idle');
    assert.strictEqual(storage.gets, baselineGets, 'idle next loop should reuse cached state');
    assert.strictEqual(storage.puts, baselinePuts, 'idle next loop should not persist lastSeen-only changes');
  });

  await run('real task offer still persists immediately and survives a new Durable Object instance', async () => {
    const storage = new CountingStorage();
    const compat = new DurableChatSwarmCompat(storage);
    const swarm = await compat.create({ name: 'storage-efficiency-durable', workerSlots: 1 });
    const browser = await compat.joinBrowserDirect({ inviteCode: swarm.inviteCode, label: 'Browser', pageKey: 'durable-page' });
    const beforeDispatchPuts = storage.puts;

    const dispatched = await compat.dispatch({
      orchestratorToken: swarm.orchestratorToken,
      tasks: [{ taskKey: 'durable-offer', prompt: 'persist me' }]
    });
    assert.ok(storage.puts > beforeDispatchPuts, 'dispatch must remain durably persisted');

    const beforeOfferPuts = storage.puts;
    const event = await compat.browserEvent(browser.browserWakeToken);
    assert.strictEqual(event.type, 'task_available');
    assert.ok(storage.puts > beforeOfferPuts, 'generic task offer lease must be persisted immediately');

    const replacement = new DurableChatSwarmCompat(storage);
    const claimed = await replacement.browserClaim(browser.browserWakeToken);
    assert.strictEqual(claimed.state, 'task');
    assert.strictEqual(claimed.task.taskId, dispatched.tasks[0].taskId);
  });

  return { passed, failed };
}
