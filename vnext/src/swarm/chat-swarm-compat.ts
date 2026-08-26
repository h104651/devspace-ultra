export type CompatTaskStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled';

export interface CompatTask {
  taskId: string;
  taskKey?: string;
  title: string;
  prompt: string;
  status: CompatTaskStatus;
  targetWorkerId?: string;
  workerId?: string;
  result?: string;
  error?: string;
  createdAt: string;
  claimedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
}

export interface CompatWorker {
  id: string;
  label: string;
  active: boolean;
  tokenHash: string;
  joinedAt: string;
  lastSeenAt: string;
  inFlightTaskId?: string;
  browserBindHash?: string;
  browserBindExpiresAt?: string;
  browserWakeTokenHash?: string;
  browserOnline?: boolean;
  browserLastSeenAt?: string;
}

export interface CompatSwarm {
  id: string;
  name: string;
  state: 'active' | 'closed';
  inviteHash: string;
  orchestratorTokenHash: string;
  workerSlots: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workers: Record<string, CompatWorker>;
  tasks: Record<string, CompatTask>;
}

interface CompatState {
  version: 1;
  swarms: Record<string, CompatSwarm>;
}

export interface CompatStorage {
  get(key: string): Promise<any>;
  put(key: string, value: any): Promise<void>;
}

const STATE_KEY = 'devspace:chat-swarm-compat:v1';
const MAX_WORKERS = 32;
const MAX_BATCH_TASKS = 64;
const MAX_RESULT_CHARS = 200_000;
const BROWSER_BIND_TTL_MS = 10 * 60_000;
const MAX_WAIT_MS = 25_000;

function nowIso(): string {
  return new Date().toISOString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes = 16): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToHex(data);
}

function randomToken(bytes = 24): string {
  return randomHex(bytes);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

function emptyState(): CompatState {
  return { version: 1, swarms: {} };
}

function taskCounts(swarm: CompatSwarm): Record<CompatTaskStatus, number> {
  const counts: Record<CompatTaskStatus, number> = {
    queued: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  };
  for (const task of Object.values(swarm.tasks)) counts[task.status]++;
  return counts;
}

export class DurableChatSwarmCompat {
  private mutationQueue: Promise<any> = Promise.resolve();

  constructor(private storage: CompatStorage) {}

  private async load(): Promise<CompatState> {
    const stored = await this.storage.get(STATE_KEY);
    if (!stored) return emptyState();
    if (typeof stored === 'string') {
      try {
        const parsed = JSON.parse(stored);
        return parsed?.version === 1 && parsed?.swarms ? parsed : emptyState();
      } catch {
        return emptyState();
      }
    }
    return stored?.version === 1 && stored?.swarms ? stored as CompatState : emptyState();
  }

  private async save(state: CompatState): Promise<void> {
    await this.storage.put(STATE_KEY, state);
  }

  private mutate<T>(operation: (state: CompatState) => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const state = await this.load();
      const result = await operation(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private touch(swarm: CompatSwarm): void {
    swarm.revision += 1;
    swarm.updatedAt = nowIso();
  }

  private activeWorkers(swarm: CompatSwarm): CompatWorker[] {
    return Object.values(swarm.workers).filter(worker => worker.active);
  }

  private async findSwarmByInvite(state: CompatState, inviteCode: string): Promise<CompatSwarm | undefined> {
    const hash = await sha256(String(inviteCode || '').trim().toUpperCase());
    return Object.values(state.swarms).find(swarm => swarm.inviteHash === hash);
  }

  private async findOrchestrator(state: CompatState, token: string): Promise<CompatSwarm> {
    const hash = await sha256(token);
    const swarm = Object.values(state.swarms).find(item => item.orchestratorTokenHash === hash);
    if (!swarm) throw new Error('Invalid orchestrator token.');
    return swarm;
  }

  private async findWorker(state: CompatState, token: string): Promise<{ swarm: CompatSwarm; worker: CompatWorker }> {
    const hash = await sha256(token);
    for (const swarm of Object.values(state.swarms)) {
      for (const worker of Object.values(swarm.workers)) {
        if (worker.active && worker.tokenHash === hash) return { swarm, worker };
      }
    }
    throw new Error('Invalid or inactive worker token.');
  }

  private async findBrowserWorker(state: CompatState, token: string): Promise<{ swarm: CompatSwarm; worker: CompatWorker }> {
    const hash = await sha256(token);
    for (const swarm of Object.values(state.swarms)) {
      for (const worker of Object.values(swarm.workers)) {
        if (worker.active && worker.browserWakeTokenHash === hash) return { swarm, worker };
      }
    }
    throw new Error('Invalid browser wake token.');
  }

  private nextWorkerId(swarm: CompatSwarm): string {
    for (let index = 1; index <= swarm.workerSlots; index++) {
      const id = `worker-${String(index).padStart(2, '0')}`;
      if (!swarm.workers[id]?.active) return id;
    }
    throw new Error('No free worker slot is available.');
  }

  private claimForWorker(swarm: CompatSwarm, worker: CompatWorker): CompatTask | undefined {
    if (worker.inFlightTaskId) {
      const current = swarm.tasks[worker.inFlightTaskId];
      if (current?.status === 'claimed') return current;
      worker.inFlightTaskId = undefined;
    }

    const queued = Object.values(swarm.tasks)
      .filter(task => task.status === 'queued')
      .filter(task => !task.targetWorkerId || task.targetWorkerId === worker.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const task = queued[0];
    if (!task) return undefined;

    task.status = 'claimed';
    task.workerId = worker.id;
    task.claimedAt = nowIso();
    worker.inFlightTaskId = task.taskId;
    worker.lastSeenAt = nowIso();
    this.touch(swarm);
    return task;
  }

  async create(input: { name?: string; workerSlots?: number }): Promise<any> {
    const workerSlots = Math.max(1, Math.min(MAX_WORKERS, Math.trunc(input.workerSlots ?? 9)));
    const inviteCode = randomHex(6).toUpperCase();
    const orchestratorToken = randomToken();
    return this.mutate(async state => {
      const id = `swarm-${randomHex(8)}`;
      const createdAt = nowIso();
      state.swarms[id] = {
        id,
        name: String(input.name || 'DevSpace Chat Swarm').slice(0, 80),
        state: 'active',
        inviteHash: await sha256(inviteCode),
        orchestratorTokenHash: await sha256(orchestratorToken),
        workerSlots,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        workers: {},
        tasks: {}
      };
      return { ok: true, swarmId: id, inviteCode, orchestratorToken, workerSlots };
    });
  }

  async join(input: { inviteCode: string; label?: string }): Promise<any> {
    const workerToken = randomToken();
    return this.mutate(async state => {
      const swarm = await this.findSwarmByInvite(state, input.inviteCode);
      if (!swarm || swarm.state !== 'active') throw new Error('Invite code is invalid or the swarm is closed.');
      if (this.activeWorkers(swarm).length >= swarm.workerSlots) throw new Error('Swarm worker capacity is full.');
      const workerId = this.nextWorkerId(swarm);
      const joinedAt = nowIso();
      swarm.workers[workerId] = {
        id: workerId,
        label: String(input.label || workerId).slice(0, 80),
        active: true,
        tokenHash: await sha256(workerToken),
        joinedAt,
        lastSeenAt: joinedAt
      };
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId, label: swarm.workers[workerId].label, workerToken };
    });
  }

  async status(token: string): Promise<any> {
    const state = await this.load();
    let swarm: CompatSwarm | undefined;
    const hash = await sha256(token);
    swarm = Object.values(state.swarms).find(item => item.orchestratorTokenHash === hash);
    if (!swarm) {
      swarm = Object.values(state.swarms).find(item => Object.values(item.workers).some(worker => worker.active && worker.tokenHash === hash));
    }
    if (!swarm) throw new Error('Invalid swarm token.');
    return {
      ok: true,
      swarmId: swarm.id,
      name: swarm.name,
      state: swarm.state,
      workerSlots: swarm.workerSlots,
      activeWorkers: this.activeWorkers(swarm).length,
      workers: this.activeWorkers(swarm).map(worker => ({
        workerId: worker.id,
        label: worker.label,
        inFlightTaskId: worker.inFlightTaskId,
        browserOnline: !!worker.browserOnline,
        lastSeenAt: worker.lastSeenAt
      })),
      taskCounts: taskCounts(swarm),
      revision: swarm.revision,
      updatedAt: swarm.updatedAt
    };
  }

  async resize(input: { orchestratorToken: string; workerSlots: number }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      if (swarm.state !== 'active') throw new Error('Swarm is closed.');
      const target = Math.max(0, Math.min(MAX_WORKERS, Math.trunc(input.workerSlots)));
      const active = this.activeWorkers(swarm);
      if (target < active.length) {
        const removeCount = active.length - target;
        const removable = active
          .filter(worker => !worker.inFlightTaskId && !Object.values(swarm.tasks).some(task => task.status === 'queued' && task.targetWorkerId === worker.id))
          .sort((a, b) => b.id.localeCompare(a.id));
        if (removable.length < removeCount) throw new Error('Cannot shrink swarm while protected workers still have active or targeted work.');
        for (const worker of removable.slice(0, removeCount)) worker.active = false;
      }
      const previousWorkerSlots = swarm.workerSlots;
      swarm.workerSlots = target;
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, previousWorkerSlots, workerSlots: target };
    });
  }

  async dispatch(input: { orchestratorToken: string; tasks: Array<any> }): Promise<any> {
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_BATCH_TASKS) {
      throw new Error(`tasks must contain between 1 and ${MAX_BATCH_TASKS} items.`);
    }
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      if (swarm.state !== 'active') throw new Error('Swarm is closed.');
      const results: CompatTask[] = [];
      const seenKeys = new Set<string>();
      for (const spec of input.tasks) {
        if (!spec?.prompt || typeof spec.prompt !== 'string') throw new Error('Each task requires a prompt.');
        if (spec.taskKey && seenKeys.has(spec.taskKey)) throw new Error(`Duplicate taskKey '${spec.taskKey}' in dispatch batch.`);
        if (spec.taskKey) seenKeys.add(spec.taskKey);
        if (spec.targetWorkerId && !swarm.workers[spec.targetWorkerId]?.active) throw new Error(`Target worker '${spec.targetWorkerId}' is not active.`);
        const replay = spec.taskKey ? Object.values(swarm.tasks).find(task => task.taskKey === spec.taskKey) : undefined;
        if (replay) {
          results.push(replay);
          continue;
        }
        const taskId = `task-${randomHex(8)}`;
        const task: CompatTask = {
          taskId,
          taskKey: spec.taskKey,
          title: String(spec.title || spec.taskTitle || 'Chat Swarm task').slice(0, 200),
          prompt: spec.prompt.slice(0, 200_000),
          status: 'queued',
          targetWorkerId: spec.targetWorkerId,
          createdAt: nowIso()
        };
        swarm.tasks[taskId] = task;
        results.push(task);
      }
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, tasks: results };
    });
  }

  async next(input: { workerToken: string; waitMs?: number }): Promise<any> {
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(input.waitMs ?? 0)));
    const deadline = Date.now() + waitMs;
    while (true) {
      const result = await this.mutate(async state => {
        const { swarm, worker } = await this.findWorker(state, input.workerToken);
        if (swarm.state !== 'active') return { state: 'closed', swarmId: swarm.id };
        const task = this.claimForWorker(swarm, worker);
        return task ? { state: 'task', swarmId: swarm.id, workerId: worker.id, task } : { state: 'idle', swarmId: swarm.id, workerId: worker.id };
      });
      if (result.state !== 'idle' || Date.now() >= deadline) return result;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
    }
  }

  async acknowledge(input: { workerToken: string; taskId: string }): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, input.workerToken);
      const task = swarm.tasks[input.taskId];
      if (!task || task.workerId !== worker.id || task.status !== 'claimed') throw new Error('Task is not claimed by this worker.');
      task.executionStartedAt = nowIso();
      worker.lastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, taskId: task.taskId };
    });
  }

  async submit(input: { workerToken: string; taskId: string; status?: 'completed' | 'failed'; result?: string; error?: string }): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, input.workerToken);
      const task = swarm.tasks[input.taskId];
      if (!task || task.workerId !== worker.id) throw new Error('Task is not owned by this worker.');
      if (task.status === 'completed' || task.status === 'failed') {
        return { ok: true, duplicate: true, swarmId: swarm.id, workerId: worker.id, taskId: task.taskId, status: task.status };
      }
      if (task.status === 'cancelled') throw new Error('Task was cancelled and can no longer be submitted.');
      const resultText = String(input.result ?? '');
      if (resultText.length > MAX_RESULT_CHARS) throw new Error(`Result exceeds ${MAX_RESULT_CHARS} characters.`);
      task.status = input.status === 'failed' ? 'failed' : 'completed';
      task.result = resultText;
      task.error = input.error;
      task.completedAt = nowIso();
      worker.inFlightTaskId = undefined;
      worker.lastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, duplicate: false, swarmId: swarm.id, workerId: worker.id, taskId: task.taskId, status: task.status, completedAt: task.completedAt };
    });
  }

  async collect(input: { orchestratorToken: string; taskIds?: string[]; waitFor?: 'none' | 'any' | 'all'; waitMs?: number }): Promise<any> {
    const waitFor = input.waitFor || 'none';
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(input.waitMs ?? 0)));
    const deadline = Date.now() + waitMs;
    while (true) {
      const state = await this.load();
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      const ids = input.taskIds?.length ? input.taskIds : Object.keys(swarm.tasks);
      const tasks = ids.map(id => swarm.tasks[id]).filter(Boolean);
      const terminal = tasks.filter(task => ['completed', 'failed', 'cancelled'].includes(task.status)).length;
      const done = waitFor === 'none' || (waitFor === 'any' && terminal > 0) || (waitFor === 'all' && terminal === tasks.length);
      if (done || Date.now() >= deadline) return { ok: true, swarmId: swarm.id, tasks, terminal, total: tasks.length };
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
    }
  }

  async cancel(input: { orchestratorToken: string; taskIds: string[] }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      const changed: CompatTask[] = [];
      for (const taskId of input.taskIds || []) {
        const task = swarm.tasks[taskId];
        if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        task.status = 'cancelled';
        task.completedAt = nowIso();
        if (task.workerId && swarm.workers[task.workerId]?.inFlightTaskId === task.taskId) swarm.workers[task.workerId].inFlightTaskId = undefined;
        changed.push(task);
      }
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, tasks: changed };
    });
  }

  async recycleWorker(input: { orchestratorToken: string; workerId: string; force?: boolean }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      const worker = swarm.workers[input.workerId];
      if (!worker?.active) throw new Error('Worker is not active.');
      let requeuedTask: CompatTask | undefined;
      if (worker.inFlightTaskId) {
        const task = swarm.tasks[worker.inFlightTaskId];
        if (task?.executionStartedAt && !input.force) throw new Error('Worker has acknowledged active execution; force=true is required to recycle it.');
        if (task && task.status === 'claimed') {
          task.status = 'queued';
          task.workerId = undefined;
          task.claimedAt = undefined;
          task.executionStartedAt = undefined;
          requeuedTask = task;
        }
      }
      worker.active = false;
      worker.inFlightTaskId = undefined;
      worker.browserOnline = false;
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, requeuedTask };
    });
  }

  async leave(workerToken: string): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, workerToken);
      if (worker.inFlightTaskId) {
        const task = swarm.tasks[worker.inFlightTaskId];
        if (task?.status === 'claimed' && swarm.state === 'active') {
          task.status = 'queued';
          task.workerId = undefined;
          task.claimedAt = undefined;
          task.executionStartedAt = undefined;
        }
      }
      worker.active = false;
      worker.inFlightTaskId = undefined;
      worker.browserOnline = false;
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id };
    });
  }

  async close(input: { orchestratorToken: string; cancelPending?: boolean }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      swarm.state = 'closed';
      if (input.cancelPending !== false) {
        for (const task of Object.values(swarm.tasks)) {
          if (task.status === 'queued' || task.status === 'claimed') {
            task.status = 'cancelled';
            task.completedAt = nowIso();
          }
        }
      }
      for (const worker of Object.values(swarm.workers)) {
        worker.inFlightTaskId = undefined;
        worker.browserOnline = false;
      }
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, state: swarm.state };
    });
  }

  async enableBrowserWake(workerToken: string): Promise<any> {
    const bindCode = randomToken(18);
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, workerToken);
      worker.browserBindHash = await sha256(bindCode);
      worker.browserBindExpiresAt = new Date(Date.now() + BROWSER_BIND_TTL_MS).toISOString();
      worker.browserWakeTokenHash = undefined;
      worker.browserOnline = false;
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, bindCode, expiresAt: worker.browserBindExpiresAt };
    });
  }

  async bindBrowser(code: string): Promise<any> {
    const browserWakeToken = randomToken();
    const hash = await sha256(String(code || '').trim());
    return this.mutate(async state => {
      for (const swarm of Object.values(state.swarms)) {
        for (const worker of Object.values(swarm.workers)) {
          if (!worker.active || worker.browserBindHash !== hash) continue;
          if (Date.parse(worker.browserBindExpiresAt || '') < Date.now()) throw new Error('Browser bind code expired.');
          worker.browserWakeTokenHash = await sha256(browserWakeToken);
          worker.browserBindHash = undefined;
          worker.browserBindExpiresAt = undefined;
          worker.browserOnline = true;
          worker.browserLastSeenAt = nowIso();
          this.touch(swarm);
          return { ok: true, swarmId: swarm.id, workerId: worker.id, browserWakeToken };
        }
      }
      throw new Error('Invalid browser bind code.');
    });
  }

  async bindBrowserByInvite(inviteCode: string): Promise<any> {
    const browserWakeToken = randomToken();
    return this.mutate(async state => {
      const swarm = await this.findSwarmByInvite(state, inviteCode);
      if (!swarm || swarm.state !== 'active') throw new Error('Invite code is invalid or the swarm is closed.');
      const worker = Object.values(swarm.workers)
        .filter(item => item.active && item.browserBindHash && !item.browserWakeTokenHash)
        .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt))[0];
      if (!worker) throw new Error('No pending browser worker is waiting to bind for this invite.');
      worker.browserWakeTokenHash = await sha256(browserWakeToken);
      worker.browserBindHash = undefined;
      worker.browserBindExpiresAt = undefined;
      worker.browserOnline = true;
      worker.browserLastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, browserWakeToken, compatibilityBind: true };
    });
  }

  async joinBrowserDirect(input: { inviteCode: string; label?: string; pageKey: string }): Promise<any> {
    const joined = await this.join({ inviteCode: input.inviteCode, label: input.label });
    const browserWakeToken = randomToken();
    await this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, joined.workerToken);
      worker.browserWakeTokenHash = await sha256(browserWakeToken);
      worker.browserOnline = true;
      worker.browserLastSeenAt = nowIso();
      this.touch(swarm);
      return undefined;
    });
    return { ...joined, browserWakeToken, browserMode: true };
  }

  async browserClaim(browserWakeToken: string): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findBrowserWorker(state, browserWakeToken);
      worker.browserOnline = true;
      worker.browserLastSeenAt = nowIso();
      if (swarm.state !== 'active') return { state: 'closed', swarmId: swarm.id, workerId: worker.id };
      const task = this.claimForWorker(swarm, worker);
      return task ? { state: 'task', swarmId: swarm.id, workerId: worker.id, task } : { state: 'idle', swarmId: swarm.id, workerId: worker.id };
    });
  }

  async browserEvent(browserWakeToken: string): Promise<any> {
    const state = await this.load();
    const { swarm, worker } = await this.findBrowserWorker(state, browserWakeToken);
    if (swarm.state !== 'active') return { type: 'closed', swarmId: swarm.id, workerId: worker.id };
    if (worker.inFlightTaskId) return { type: 'busy', swarmId: swarm.id, workerId: worker.id, taskId: worker.inFlightTaskId };
    const available = Object.values(swarm.tasks)
      .find(task => task.status === 'queued' && (!task.targetWorkerId || task.targetWorkerId === worker.id));
    return available
      ? { type: 'task_available', swarmId: swarm.id, workerId: worker.id, taskId: available.taskId }
      : { type: 'parked', swarmId: swarm.id, workerId: worker.id };
  }
}
