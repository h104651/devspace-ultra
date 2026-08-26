export type CompatTaskStatus = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled';

export interface CompatTask {
  taskId: string;
  taskKey?: string;
  prompt: string;
  status: CompatTaskStatus;
  targetWorkerId?: string;
  workerId?: string;
  result?: string;
  error?: string;
  cancelReason?: string;
  createdAt: string;
  claimedAt?: string;
  executionStartedAt?: string;
  completedAt?: string;
  offeredWorkerId?: string;
  offeredAt?: string;
}

export interface CompatWorker {
  id: string;
  slot: number;
  label: string;
  active: boolean;
  tokenHash: string;
  joinedAt: string;
  lastSeenAt: string;
  inFlightTaskId?: string;
  desktopWakeMarker?: string;
  joinInviteCode?: string;
  browserPageFingerprint?: string;
  browserBindHash?: string;
  browserBindExpiresAt?: string;
  browserWakeTokenHash?: string;
  browserOnline?: boolean;
  browserLastSeenAt?: string;
  dockOnline?: boolean;
  dockLastSeenAt?: string;
  progressHeartbeat?: boolean;
  progressHeartbeatLastSeenAt?: string;
  checkpointCount?: number;
  lastCheckpointAt?: string;
  recycledAt?: string;
  recycleReason?: string;
  leftAt?: string;
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
  closedAt?: string;
  workers: Record<string, CompatWorker>;
  tasks: Record<string, CompatTask>;
  taskKeys: Record<string, string>;
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
const MAX_PROMPT_CHARS = 100_000;
const BROWSER_BIND_TTL_MS = 10 * 60_000;
const WORKER_OFFER_LEASE_MS = 60_000;
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
      for (const swarm of Object.values(state.swarms)) {
        swarm.taskKeys ||= {};
        for (const worker of Object.values(swarm.workers || {})) {
          worker.slot ||= Number(worker.id?.match(/worker-(\d{2})/)?.[1] || 0);
        }
      }
      const result = await operation(state);
      await this.save(state);
      return result;
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private touch(swarm: CompatSwarm): void {
    swarm.revision = Number.isInteger(swarm.revision) ? swarm.revision + 1 : 1;
    swarm.updatedAt = nowIso();
  }

  private activeWorkers(swarm: CompatSwarm): CompatWorker[] {
    return Object.values(swarm.workers).filter(worker => worker.active);
  }

  private publicTask(task: CompatTask): CompatTask {
    return {
      taskId: task.taskId,
      taskKey: task.taskKey,
      prompt: task.prompt,
      status: task.status,
      targetWorkerId: task.targetWorkerId,
      workerId: task.workerId,
      result: task.result,
      error: task.error,
      cancelReason: task.cancelReason,
      createdAt: task.createdAt,
      claimedAt: task.claimedAt,
      executionStartedAt: task.executionStartedAt,
      completedAt: task.completedAt
    };
  }

  private summary(swarm: CompatSwarm, role: 'orchestrator' | 'worker', worker?: CompatWorker): any {
    const workers = this.activeWorkers(swarm).sort((a, b) => a.slot - b.slot);
    return {
      ok: true,
      swarmId: swarm.id,
      name: swarm.name,
      state: swarm.state,
      role,
      workerId: worker?.id,
      workerSlots: swarm.workerSlots,
      activeWorkers: workers.length,
      workers: workers.map(item => ({
        workerId: item.id,
        label: item.label,
        slot: item.slot,
        joinedAt: item.joinedAt,
        lastSeenAt: item.lastSeenAt,
        inFlightTaskId: item.inFlightTaskId,
        browserOnline: Boolean(item.browserOnline),
        browserLastSeenAt: item.browserLastSeenAt,
        dockOnline: Boolean(item.dockOnline),
        dockLastSeenAt: item.dockLastSeenAt,
        progressHeartbeat: Boolean(item.progressHeartbeat),
        progressHeartbeatLastSeenAt: item.progressHeartbeatLastSeenAt,
        checkpointCount: Number(item.checkpointCount || 0),
        lastCheckpointAt: item.lastCheckpointAt
      })),
      taskCounts: taskCounts(swarm),
      revision: swarm.revision,
      createdAt: swarm.createdAt,
      updatedAt: swarm.updatedAt,
      closedAt: swarm.closedAt
    };
  }

  private async findSwarmByInvite(state: CompatState, inviteCode: string): Promise<CompatSwarm | undefined> {
    const normalized = String(inviteCode || '').trim().toUpperCase();
    const hash = await sha256(normalized);
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
    throw new Error('Invalid or inactive browser wake token.');
  }

  private nextFreeSlot(swarm: CompatSwarm): number {
    const used = new Set(this.activeWorkers(swarm).map(worker => worker.slot));
    for (let slot = 1; slot <= swarm.workerSlots; slot++) if (!used.has(slot)) return slot;
    throw new Error('No free worker slot is available.');
  }

  private async addWorker(
    swarm: CompatSwarm,
    inviteCode: string,
    label?: string,
    browserPageFingerprint?: string
  ): Promise<{ worker: CompatWorker; workerToken: string }> {
    if (swarm.state !== 'active') throw new Error('Invite code is invalid or the swarm is closed.');
    const active = this.activeWorkers(swarm);
    if (active.length >= swarm.workerSlots) throw new Error(`This swarm already has all ${swarm.workerSlots} worker slots filled.`);
    const requestedLabel = String(label || '').trim();
    if (requestedLabel && active.some(worker => worker.label === requestedLabel)) {
      throw new Error(`Worker label ${requestedLabel} is already in use.`);
    }
    const slot = this.nextFreeSlot(swarm);
    const workerId = `worker-${String(slot).padStart(2, '0')}`;
    const workerToken = randomToken();
    const joinedAt = nowIso();
    const worker: CompatWorker = {
      id: workerId,
      slot,
      label: requestedLabel || workerId,
      active: true,
      tokenHash: await sha256(workerToken),
      joinedAt,
      lastSeenAt: joinedAt,
      desktopWakeMarker: `[[CHAT_SWARM_DESKTOP:${randomToken(12)}]]`,
      joinInviteCode: inviteCode.trim().toUpperCase(),
      browserPageFingerprint
    };
    swarm.workers[workerId] = worker;
    this.touch(swarm);
    return { worker, workerToken };
  }

  private offerExpired(task: CompatTask): boolean {
    if (!task.offeredWorkerId) return true;
    const offeredAt = Date.parse(task.offeredAt || '');
    return !Number.isFinite(offeredAt) || Date.now() - offeredAt >= WORKER_OFFER_LEASE_MS;
  }

  private reserveAvailableTask(swarm: CompatSwarm, worker: CompatWorker): CompatTask | undefined {
    if (worker.inFlightTaskId) {
      const inFlight = swarm.tasks[worker.inFlightTaskId];
      if (inFlight?.status === 'claimed' && inFlight.workerId === worker.id) return inFlight;
      worker.inFlightTaskId = undefined;
    }

    const queued = Object.values(swarm.tasks)
      .filter(task => task.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let task = queued.find(item => item.targetWorkerId === worker.id);
    if (!task) {
      task = queued.find(item => {
        if (item.targetWorkerId) return false;
        return !item.offeredWorkerId || item.offeredWorkerId === worker.id || this.offerExpired(item);
      });
    }
    if (!task) return undefined;

    if (!task.targetWorkerId && task.offeredWorkerId !== worker.id) {
      task.offeredWorkerId = worker.id;
      task.offeredAt = nowIso();
      this.touch(swarm);
    }
    return task;
  }

  private claimForWorker(swarm: CompatSwarm, worker: CompatWorker): { task: CompatTask; replay: boolean } | undefined {
    if (worker.inFlightTaskId) {
      const current = swarm.tasks[worker.inFlightTaskId];
      if (current?.status === 'claimed' && current.workerId === worker.id) {
        worker.lastSeenAt = nowIso();
        return { task: current, replay: true };
      }
      worker.inFlightTaskId = undefined;
    }

    const reserved = this.reserveAvailableTask(swarm, worker);
    if (!reserved || reserved.status !== 'queued') return undefined;

    reserved.status = 'claimed';
    reserved.workerId = worker.id;
    reserved.claimedAt = nowIso();
    reserved.executionStartedAt = undefined;
    reserved.offeredWorkerId = undefined;
    reserved.offeredAt = undefined;
    worker.inFlightTaskId = reserved.taskId;
    worker.lastSeenAt = nowIso();
    this.touch(swarm);
    return { task: reserved, replay: false };
  }

  async create(input: { name?: string; workerSlots?: number }): Promise<any> {
    const workerSlots = Math.trunc(input.workerSlots ?? 9);
    if (!Number.isInteger(workerSlots) || workerSlots < 1 || workerSlots > MAX_WORKERS) {
      throw new Error(`workerSlots must be between 1 and ${MAX_WORKERS}.`);
    }
    const inviteCode = randomHex(6).toUpperCase();
    const orchestratorToken = randomToken();
    return this.mutate(async state => {
      const id = `swarm_${randomHex(8)}`;
      const createdAt = nowIso();
      state.swarms[id] = {
        id,
        name: String(input.name || `Chat Swarm ${id.slice(-6)}`).trim().slice(0, 80),
        state: 'active',
        inviteHash: await sha256(inviteCode),
        orchestratorTokenHash: await sha256(orchestratorToken),
        workerSlots,
        revision: 0,
        createdAt,
        updatedAt: createdAt,
        workers: {},
        tasks: {},
        taskKeys: {}
      };
      return {
        ok: true,
        swarmId: id,
        inviteCode,
        orchestratorToken,
        workerSlots,
        instruction: `Open ${workerSlots} worker conversations and join them with inviteCode ${inviteCode}.`
      };
    });
  }

  async join(input: { inviteCode: string; label?: string }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findSwarmByInvite(state, input.inviteCode);
      if (!swarm) throw new Error('Invite code is invalid or the swarm is closed.');
      const joined = await this.addWorker(swarm, input.inviteCode, input.label);
      return {
        ok: true,
        swarmId: swarm.id,
        workerId: joined.worker.id,
        label: joined.worker.label,
        workerToken: joined.workerToken,
        desktopWakeMarker: joined.worker.desktopWakeMarker,
        instruction: 'Keep this workerToken private. Use chat_swarm_next to wait for work and submit results only through chat_swarm_submit.'
      };
    });
  }

  async status(token: string): Promise<any> {
    return this.mutate(async state => {
      const hash = await sha256(token);
      const orchestrator = Object.values(state.swarms).find(item => item.orchestratorTokenHash === hash);
      if (orchestrator) return this.summary(orchestrator, 'orchestrator');

      const { swarm, worker } = await this.findWorker(state, token);
      worker.lastSeenAt = nowIso();
      if (worker.inFlightTaskId) {
        const task = swarm.tasks[worker.inFlightTaskId];
        if (task?.status === 'claimed' && task.workerId === worker.id && !task.executionStartedAt) {
          task.executionStartedAt = worker.lastSeenAt;
        }
      }
      this.touch(swarm);
      return this.summary(swarm, 'worker', worker);
    });
  }

  async setDockOnline(workerToken: string, online: boolean): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, workerToken);
      worker.dockOnline = Boolean(online);
      worker.dockLastSeenAt = nowIso();
      worker.lastSeenAt = worker.dockLastSeenAt;
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, dockOnline: worker.dockOnline };
    });
  }

  async workerEvent(workerToken: string): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, workerToken);
      worker.dockOnline = true;
      worker.dockLastSeenAt = nowIso();
      worker.lastSeenAt = worker.dockLastSeenAt;
      if (swarm.state !== 'active') return { type: 'closed', swarmId: swarm.id, workerId: worker.id };

      if (worker.inFlightTaskId) {
        const inFlight = swarm.tasks[worker.inFlightTaskId];
        if (inFlight?.status === 'claimed' && inFlight.workerId === worker.id) {
          return { type: 'busy', swarmId: swarm.id, workerId: worker.id, taskId: inFlight.taskId };
        }
        worker.inFlightTaskId = undefined;
      }

      const task = this.reserveAvailableTask(swarm, worker);
      if (!task) return { type: 'parked', swarmId: swarm.id, workerId: worker.id };
      return {
        type: 'task_available',
        swarmId: swarm.id,
        workerId: worker.id,
        taskId: task.taskId,
        targeted: Boolean(task.targetWorkerId)
      };
    });
  }

  async resize(input: { orchestratorToken: string; workerSlots: number }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      if (swarm.state !== 'active') throw new Error('Swarm is closed.');
      const target = Math.trunc(input.workerSlots);
      if (!Number.isInteger(target) || target < 0 || target > MAX_WORKERS) {
        throw new Error(`workerSlots must be between 0 and ${MAX_WORKERS}.`);
      }
      const previousWorkerSlots = swarm.workerSlots;
      const active = this.activeWorkers(swarm);
      if (target >= active.length) {
        swarm.workerSlots = target;
        this.touch(swarm);
        return { ok: true, swarmId: swarm.id, previousWorkerSlots, workerSlots: target, activeWorkers: active.length, removedWorkers: [] };
      }

      const removalCount = active.length - target;
      const victims = [...active].sort((a, b) => b.slot - a.slot).slice(0, removalCount);
      const protectedIds = new Set<string>();
      for (const worker of active) if (worker.inFlightTaskId) protectedIds.add(worker.id);
      for (const task of Object.values(swarm.tasks)) {
        if (['queued', 'claimed'].includes(task.status) && task.targetWorkerId) protectedIds.add(task.targetWorkerId);
      }
      const blocked = victims.filter(worker => protectedIds.has(worker.id)).map(worker => worker.id);
      if (blocked.length) {
        throw new Error(`Cannot shrink swarm to ${target} workers while required tail workers are busy or targeted: ${blocked.join(', ')}.`);
      }

      const victimIds = new Set(victims.map(worker => worker.id));
      for (const task of Object.values(swarm.tasks)) {
        if (task.status === 'queued' && task.offeredWorkerId && victimIds.has(task.offeredWorkerId)) {
          task.offeredWorkerId = undefined;
          task.offeredAt = undefined;
        }
      }
      for (const worker of victims) {
        worker.active = false;
        worker.inFlightTaskId = undefined;
        worker.browserOnline = false;
        worker.dockOnline = false;
      }
      swarm.workerSlots = target;
      this.touch(swarm);
      return {
        ok: true,
        swarmId: swarm.id,
        previousWorkerSlots,
        workerSlots: target,
        activeWorkers: target,
        removedWorkers: victims.map(worker => ({ workerId: worker.id, label: worker.label, slot: worker.slot }))
      };
    });
  }

  async dispatch(input: { orchestratorToken: string; tasks: Array<any> }): Promise<any> {
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_BATCH_TASKS) {
      throw new Error(`tasks must contain between 1 and ${MAX_BATCH_TASKS} items.`);
    }
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      if (swarm.state !== 'active') throw new Error('Swarm is closed.');
      const seenKeys = new Set<string>();

      for (const spec of input.tasks) {
        if (!spec?.prompt || typeof spec.prompt !== 'string') throw new Error('Each task requires a prompt.');
        if (spec.prompt.length > MAX_PROMPT_CHARS) throw new Error(`Task prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
        if (spec.taskKey && seenKeys.has(spec.taskKey)) throw new Error(`Duplicate taskKey '${spec.taskKey}' in dispatch batch.`);
        if (spec.taskKey) seenKeys.add(spec.taskKey);
        if (spec.targetWorkerId && !swarm.workers[spec.targetWorkerId]?.active) {
          throw new Error(`Target worker '${spec.targetWorkerId}' is not active.`);
        }
      }

      const results: CompatTask[] = [];
      for (const spec of input.tasks) {
        const replayId = spec.taskKey ? swarm.taskKeys[spec.taskKey] : undefined;
        const replay = replayId ? swarm.tasks[replayId] : undefined;
        if (replay) {
          results.push(this.publicTask(replay));
          continue;
        }
        const taskId = `task_${randomHex(8)}`;
        const task: CompatTask = {
          taskId,
          taskKey: spec.taskKey,
          prompt: spec.prompt,
          status: 'queued',
          targetWorkerId: spec.targetWorkerId,
          createdAt: nowIso()
        };
        swarm.tasks[taskId] = task;
        if (spec.taskKey) swarm.taskKeys[spec.taskKey] = taskId;
        results.push(this.publicTask(task));
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
        if (swarm.state !== 'active') return { state: 'closed', swarmId: swarm.id, workerId: worker.id };
        const claimed = this.claimForWorker(swarm, worker);
        if (claimed) {
          return {
            state: 'task',
            swarmId: swarm.id,
            workerId: worker.id,
            task: this.publicTask(claimed.task),
            replay: claimed.replay
          };
        }
        worker.lastSeenAt = nowIso();
        return { state: 'idle', swarmId: swarm.id, workerId: worker.id };
      });
      if (result.state !== 'idle' || Date.now() >= deadline) {
        if (result.state === 'idle') {
          return { ...result, waitedMs: waitMs, checkpoint: waitMs > 0 };
        }
        return result;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
    }
  }

  async acknowledge(input: { workerToken: string; taskId: string }): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, input.workerToken);
      const task = swarm.tasks[input.taskId];
      if (!task) throw new Error(`Unknown task ${input.taskId}.`);
      if (task.workerId !== worker.id || task.status !== 'claimed') throw new Error(`Task ${input.taskId} is not claimed by ${worker.id}.`);
      if (!task.executionStartedAt) task.executionStartedAt = nowIso();
      worker.lastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, taskId: task.taskId, executionStartedAt: task.executionStartedAt };
    });
  }

  async submit(input: {
    workerToken: string;
    taskId: string;
    status?: 'completed' | 'failed';
    result?: string;
    error?: string;
    waitForNextMs?: number;
  }): Promise<any> {
    const submitted: any = await this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, input.workerToken);
      const task = swarm.tasks[input.taskId];
      if (!task) throw new Error(`Unknown task ${input.taskId}.`);
      if (task.status === 'cancelled') throw new Error(`Task ${input.taskId} was cancelled and cannot accept a result.`);
      if (task.status === 'completed' || task.status === 'failed') {
        if (task.workerId !== worker.id) throw new Error(`Task ${input.taskId} was already completed by another worker.`);
        return { ok: true, duplicate: true, submitted: this.publicTask(task) };
      }
      if (task.status !== 'claimed' || task.workerId !== worker.id) throw new Error(`Task ${input.taskId} is not claimed by ${worker.id}.`);
      const resultText = String(input.result ?? '');
      if (resultText.length > MAX_RESULT_CHARS) throw new Error(`Result exceeds ${MAX_RESULT_CHARS} characters.`);
      task.status = input.status === 'failed' ? 'failed' : 'completed';
      task.result = resultText;
      task.error = input.error;
      task.completedAt = nowIso();
      worker.inFlightTaskId = undefined;
      worker.lastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, duplicate: false, submitted: this.publicTask(task) };
    });

    if ((input.waitForNextMs ?? 0) !== 0) {
      submitted.next = await this.next({ workerToken: input.workerToken, waitMs: input.waitForNextMs });
    }
    return submitted;
  }

  async collect(input: { orchestratorToken: string; taskIds?: string[]; waitFor?: 'none' | 'any' | 'all'; waitMs?: number }): Promise<any> {
    const waitFor = input.waitFor || 'none';
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.trunc(input.waitMs ?? 0)));
    const deadline = Date.now() + waitMs;
    while (true) {
      const state = await this.load();
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      const ids = input.taskIds?.length ? input.taskIds : Object.keys(swarm.tasks);
      const tasks = ids.map(id => {
        const task = swarm.tasks[id];
        if (!task) throw new Error(`Unknown task ${id}.`);
        return task;
      });
      const terminal = tasks.filter(task => ['completed', 'failed', 'cancelled'].includes(task.status)).length;
      const satisfied = waitFor === 'none' || (waitFor === 'any' && terminal > 0) || (waitFor === 'all' && terminal === tasks.length);
      if (satisfied || Date.now() >= deadline) {
        return {
          ok: true,
          swarmId: swarm.id,
          waitFor,
          complete: tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status)),
          tasks: tasks.map(task => this.publicTask(task))
        };
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
    }
  }

  async cancel(input: { orchestratorToken: string; taskIds: string[]; reason?: string }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      const changed: CompatTask[] = [];
      for (const taskId of input.taskIds || []) {
        const task = swarm.tasks[taskId];
        if (!task) throw new Error(`Unknown task ${taskId}.`);
        if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        task.status = 'cancelled';
        task.cancelReason = input.reason;
        task.completedAt = nowIso();
        if (task.workerId && swarm.workers[task.workerId]?.inFlightTaskId === task.taskId) {
          swarm.workers[task.workerId].inFlightTaskId = undefined;
        }
        task.offeredWorkerId = undefined;
        task.offeredAt = undefined;
        changed.push(this.publicTask(task));
      }
      if (changed.length) this.touch(swarm);
      return { ok: true, swarmId: swarm.id, tasks: changed };
    });
  }

  async recycleWorker(input: { orchestratorToken: string; workerId: string; force?: boolean; reason?: string }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      if (swarm.state !== 'active') throw new Error('Swarm is closed.');
      const worker = swarm.workers[input.workerId];
      if (!worker) throw new Error(`Unknown worker ${input.workerId}.`);
      if (!worker.active) return { ok: true, swarmId: swarm.id, workerId: worker.id, state: 'recycled', duplicate: true };

      let requeuedTask: CompatTask | undefined;
      if (worker.inFlightTaskId) {
        const task = swarm.tasks[worker.inFlightTaskId];
        if (task?.status === 'claimed' && task.workerId === worker.id) {
          if (task.executionStartedAt && !input.force) {
            throw new Error(`Worker ${worker.id} has task ${task.taskId} with execution already started; refuse recycle without force.`);
          }
          task.status = 'queued';
          task.workerId = undefined;
          task.claimedAt = undefined;
          task.executionStartedAt = undefined;
          task.offeredWorkerId = undefined;
          task.offeredAt = undefined;
          requeuedTask = this.publicTask(task);
        }
      }
      worker.active = false;
      worker.inFlightTaskId = undefined;
      worker.browserOnline = false;
      worker.dockOnline = false;
      worker.recycledAt = nowIso();
      worker.recycleReason = input.reason;
      this.touch(swarm);
      return {
        ok: true,
        swarmId: swarm.id,
        workerId: worker.id,
        state: 'recycled',
        duplicate: false,
        forced: Boolean(input.force),
        requeuedTask
      };
    });
  }

  async leave(workerToken: string): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findWorker(state, workerToken);
      if (worker.inFlightTaskId) {
        const task = swarm.tasks[worker.inFlightTaskId];
        if (task?.status === 'claimed') {
          task.status = swarm.state === 'active' ? 'queued' : 'cancelled';
          task.workerId = undefined;
          task.claimedAt = undefined;
          task.executionStartedAt = undefined;
          task.offeredWorkerId = undefined;
          task.offeredAt = undefined;
          if (task.status === 'cancelled') task.completedAt = nowIso();
        }
      }
      for (const task of Object.values(swarm.tasks)) {
        if (task.status === 'queued' && task.offeredWorkerId === worker.id) {
          task.offeredWorkerId = undefined;
          task.offeredAt = undefined;
        }
      }
      worker.active = false;
      worker.inFlightTaskId = undefined;
      worker.browserOnline = false;
      worker.dockOnline = false;
      worker.leftAt = nowIso();
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, state: 'left' };
    });
  }

  async close(input: { orchestratorToken: string; cancelPending?: boolean }): Promise<any> {
    return this.mutate(async state => {
      const swarm = await this.findOrchestrator(state, input.orchestratorToken);
      if (swarm.state === 'closed') return { ok: true, swarmId: swarm.id, state: 'closed', duplicate: true };
      swarm.state = 'closed';
      swarm.closedAt = nowIso();
      if (input.cancelPending !== false) {
        for (const task of Object.values(swarm.tasks)) {
          if (task.status === 'queued' || task.status === 'claimed') {
            task.status = 'cancelled';
            task.cancelReason = 'swarm closed';
            task.completedAt = nowIso();
            task.offeredWorkerId = undefined;
            task.offeredAt = undefined;
          }
        }
        for (const worker of Object.values(swarm.workers)) worker.inFlightTaskId = undefined;
      }
      for (const worker of Object.values(swarm.workers)) {
        worker.browserOnline = false;
        worker.dockOnline = false;
      }
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, state: 'closed', duplicate: false };
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
          const expiresAt = Date.parse(worker.browserBindExpiresAt || '');
          if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) throw new Error('Browser bind code expired.');
          worker.browserWakeTokenHash = await sha256(browserWakeToken);
          worker.browserBindHash = undefined;
          worker.browserBindExpiresAt = undefined;
          worker.browserOnline = false;
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
      worker.browserOnline = false;
      worker.browserLastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, browserWakeToken, compatibilityBind: true };
    });
  }

  async joinBrowserDirect(input: { inviteCode: string; label?: string; pageKey: string }): Promise<any> {
    const fingerprint = (await sha256(String(input.pageKey || '').trim())).slice(0, 16);
    if (!String(input.pageKey || '').trim()) throw new Error('Browser page key is required.');
    const browserWakeToken = randomToken();
    return this.mutate(async state => {
      const swarm = await this.findSwarmByInvite(state, input.inviteCode);
      if (!swarm || swarm.state !== 'active') throw new Error('Invite code is invalid or the swarm is closed.');
      let worker = Object.values(swarm.workers).find(item => item.active && item.browserPageFingerprint === fingerprint);
      let workerToken: string;
      let directBrowserJoin = false;

      if (!worker) {
        const joined = await this.addWorker(swarm, input.inviteCode, input.label, fingerprint);
        worker = joined.worker;
        workerToken = joined.workerToken;
        directBrowserJoin = true;
      } else {
        workerToken = randomToken();
        worker.tokenHash = await sha256(workerToken);
        worker.lastSeenAt = nowIso();
      }

      worker.browserWakeTokenHash = await sha256(browserWakeToken);
      worker.browserBindHash = undefined;
      worker.browserBindExpiresAt = undefined;
      worker.browserOnline = false;
      worker.browserLastSeenAt = nowIso();
      this.touch(swarm);
      return {
        ok: true,
        swarmId: swarm.id,
        workerId: worker.id,
        label: worker.label,
        workerToken,
        browserWakeToken,
        browserMode: true,
        directBrowserJoin
      };
    });
  }

  async setBrowserOnline(browserWakeToken: string, online: boolean): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findBrowserWorker(state, browserWakeToken);
      worker.browserOnline = Boolean(online);
      worker.browserLastSeenAt = nowIso();
      this.touch(swarm);
      return { ok: true, swarmId: swarm.id, workerId: worker.id, browserOnline: worker.browserOnline };
    });
  }

  async browserClaim(browserWakeToken: string): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findBrowserWorker(state, browserWakeToken);
      worker.browserOnline = true;
      worker.browserLastSeenAt = nowIso();
      if (swarm.state !== 'active') return { state: 'closed', swarmId: swarm.id, workerId: worker.id };
      const claimed = this.claimForWorker(swarm, worker);
      return claimed
        ? { state: 'task', swarmId: swarm.id, workerId: worker.id, task: this.publicTask(claimed.task), replay: claimed.replay }
        : { state: 'idle', swarmId: swarm.id, workerId: worker.id };
    });
  }

  async browserEvent(browserWakeToken: string): Promise<any> {
    return this.mutate(async state => {
      const { swarm, worker } = await this.findBrowserWorker(state, browserWakeToken);
      worker.browserOnline = true;
      worker.browserLastSeenAt = nowIso();
      if (swarm.state !== 'active') return { type: 'closed', swarmId: swarm.id, workerId: worker.id };
      if (worker.inFlightTaskId) {
        const inFlight = swarm.tasks[worker.inFlightTaskId];
        if (inFlight?.status === 'claimed') return { type: 'busy', swarmId: swarm.id, workerId: worker.id, taskId: inFlight.taskId };
        worker.inFlightTaskId = undefined;
      }

      const task = this.reserveAvailableTask(swarm, worker);
      if (!task) return { type: 'parked', swarmId: swarm.id, workerId: worker.id };
      return {
        type: 'task_available',
        swarmId: swarm.id,
        workerId: worker.id,
        taskId: task.taskId,
        targeted: Boolean(task.targetWorkerId)
      };
    });
  }
}
