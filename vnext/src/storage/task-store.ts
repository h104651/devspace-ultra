import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  CreateTaskOptions,
  DurableTask,
  TaskStatus,
  TaskArtifactSummary,
  TaskAttempt,
  TaskAttemptStatus
} from '../types/task';
import { ScopeChecker } from '../security/scope-checker';
import { IStorageAdapter } from './storage-adapter.interface';

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled', 'stale']);
const ACTIVE_ATTEMPT_STATUSES = new Set<TaskAttemptStatus>(['claimed', 'acknowledged', 'running']);

type TaskWaitListener = (task: DurableTask) => void;

export interface TaskWaitResult {
  task: DurableTask;
  timedOut: boolean;
}

export class TaskStore {
  private tasksDir?: string;
  private tasks: Map<string, DurableTask> = new Map();
  private defaultLeaseDurationMs: number;
  private storageAdapter?: IStorageAdapter;
  private taskWaiters: Map<string, Set<TaskWaitListener>> = new Map();

  constructor(storageDir?: string, defaultLeaseDurationMs = 60000, storageAdapter?: IStorageAdapter) {
    this.defaultLeaseDurationMs = defaultLeaseDurationMs;
    this.storageAdapter = storageAdapter;
    if (storageDir && storageDir !== ':memory:') {
      this.tasksDir = path.join(storageDir, 'tasks');
      try {
        if (!fs.existsSync(this.tasksDir)) {
          fs.mkdirSync(this.tasksDir, { recursive: true });
        }
        this.loadAll();
      } catch {}
    }
  }

  public hydrate(tasks: DurableTask[]): void {
    for (const task of tasks || []) {
      if (task?.taskId) {
        this.normalizeAttemptLedger(task);
        this.tasks.set(task.taskId, task);
      }
    }
  }

  private loadAll() {
    if (!this.tasksDir) return;
    try {
      const files = fs.readdirSync(this.tasksDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(path.join(this.tasksDir, file), 'utf-8');
            const task: DurableTask = JSON.parse(raw);
            this.normalizeAttemptLedger(task);
            this.tasks.set(task.taskId, task);
          } catch (err) {
            console.error(`Failed to load task file ${file}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('Failed to read tasks directory:', err);
    }
  }

  private normalizeAttemptLedger(task: DurableTask): void {
    if (!Array.isArray(task.attempts)) task.attempts = [];
    if (task.activeAttemptId && !task.attempts.some(attempt => attempt.id === task.activeAttemptId)) {
      // A dangling pointer from an interrupted/partial older write is never
      // treated as proof that work is active. Task/lease state remains the
      // authority and the next valid transition can create a replacement record.
      task.activeAttemptId = undefined;
    }
  }

  private saveTask(task: DurableTask) {
    task.updatedAt = Date.now();

    if (this.tasksDir) {
      try {
        if (!fs.existsSync(this.tasksDir)) {
          fs.mkdirSync(this.tasksDir, { recursive: true });
        }
        const taskPath = path.join(this.tasksDir, `${task.taskId}.json`);
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
      } catch {}
    }

    if (this.storageAdapter) {
      void this.storageAdapter.saveTask(task).catch(err => {
        console.error(`Failed to persist task ${task.taskId} through storage adapter:`, err);
      });
    }

    this.notifyTaskChanged(task);
  }

  private notifyTaskChanged(task: DurableTask): void {
    const listeners = this.taskWaiters.get(task.taskId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of Array.from(listeners)) listener(task);
  }

  private getActiveAttempt(task: DurableTask): TaskAttempt | undefined {
    if (!task.activeAttemptId || !task.attempts) return undefined;
    return task.attempts.find(attempt => attempt.id === task.activeAttemptId);
  }

  private createAttempt(task: DurableTask, deviceId: string, claimedAt = Date.now()): TaskAttempt | undefined {
    this.normalizeAttemptLedger(task);
    const referenced = this.getActiveAttempt(task);
    if (referenced && ACTIVE_ATTEMPT_STATUSES.has(referenced.status)) return undefined;
    if (referenced) task.activeAttemptId = undefined;

    const attempts = task.attempts!;
    const attemptNumber = attempts.length + 1;
    const attempt: TaskAttempt = {
      id: `attempt-${attemptNumber}-${crypto.randomBytes(4).toString('hex')}`,
      attemptNumber,
      status: 'claimed',
      claimedBy: deviceId,
      claimedAt
    };
    attempts.push(attempt);
    task.activeAttemptId = attempt.id;
    return attempt;
  }

  /**
   * Backwards-compatible migration for tasks that were already claimed/running
   * when the attempt ledger was introduced. It creates history only from an
   * authoritative current lease and never guesses another owner.
   */
  private ensureActiveAttempt(task: DurableTask, deviceId: string): TaskAttempt | undefined {
    this.normalizeAttemptLedger(task);
    const current = this.getActiveAttempt(task);
    if (current) return current.claimedBy === deviceId ? current : undefined;
    if (!task.lease || task.lease.claimedBy !== deviceId) return undefined;

    const attempt = this.createAttempt(task, deviceId, task.lease.claimedAt);
    if (!attempt) return undefined;
    if (task.status === 'acknowledged') {
      attempt.status = 'acknowledged';
      attempt.acknowledgedAt = task.lease.acknowledgedAt;
    } else if (task.status === 'running') {
      attempt.status = 'running';
      attempt.acknowledgedAt = task.lease.acknowledgedAt;
      attempt.startedAt = task.startedAt;
    }
    return attempt;
  }

  private finishActiveAttempt(
    task: DurableTask,
    status: Extract<TaskAttemptStatus, 'succeeded' | 'failed' | 'interrupted' | 'cancelled'>,
    error?: { code?: string; message?: string }
  ): void {
    this.normalizeAttemptLedger(task);
    const attempt = this.getActiveAttempt(task);
    if (!attempt) {
      task.activeAttemptId = undefined;
      return;
    }

    attempt.status = status;
    attempt.completedAt = Date.now();
    if (error?.code) attempt.errorCode = error.code;
    if (error?.message) attempt.errorMessage = error.message;
    task.activeAttemptId = undefined;
  }

  public createTask<TPayload = any>(options: CreateTaskOptions<TPayload>): DurableTask<TPayload> {
    const taskId = options.taskId || `task-${crypto.randomBytes(8).toString('hex')}`;
    const requiredScope = options.requiredScope || ScopeChecker.getRequiredScopeForCapability(options.capability);

    const task: DurableTask<TPayload> = {
      taskId,
      taskKey: options.taskKey,
      idempotencyKey: options.idempotencyKey,
      clientRequestId: options.clientRequestId,
      backend: options.backend,
      capability: options.capability,
      requiredScope,
      status: 'queued',
      priority: options.priority ?? 0,
      payload: options.payload,
      retryPolicy: {
        maxRetries: options.maxRetries ?? 3,
        retryCount: 0,
        backoffMs: 2000,
        requeueOnStale: true
      },
      attempts: [],
      artifacts: [],
      logs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: options.metadata
    };

    this.tasks.set(taskId, task);
    this.saveTask(task);
    return task;
  }

  public getTask(taskId: string): DurableTask | undefined {
    const cached = this.tasks.get(taskId);
    if (cached) return cached;

    // Cloudflare Durable Object SQLite is synchronously queryable even though the
    // general adapter contract is async. Use that optional fast path only for a
    // cache miss so terminal history can stay out of cold-start hydration.
    const durable = this.storageAdapter?.getTaskSync?.(taskId);
    if (durable) {
      this.normalizeAttemptLedger(durable);
      this.tasks.set(taskId, durable);
    }
    return durable;
  }

  public findByIdempotencyKey(key: string): DurableTask | undefined {
    for (const t of this.tasks.values()) {
      if (t.idempotencyKey === key || t.clientRequestId === key || t.taskKey === key) {
        return t;
      }
    }
    return undefined;
  }

  /**
   * Wait for one task to reach a terminal state without status polling.
   *
   * The waiter is process-local and bounded by timeout; durable task state stays
   * authoritative, so a caller can safely retry wait after a process/DO restart.
   */
  public waitForTask(taskId: string, options?: { timeoutMs?: number }): Promise<TaskWaitResult> {
    const initial = this.getTask(taskId);
    if (!initial) return Promise.reject(new Error(`TASK_NOT_FOUND: ${taskId}`));
    if (TERMINAL_TASK_STATUSES.has(initial.status)) {
      return Promise.resolve({ task: initial, timedOut: false });
    }

    const timeoutMs = Math.max(0, options?.timeoutMs ?? 30000);
    return new Promise<TaskWaitResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const listeners = this.taskWaiters.get(taskId);
        listeners?.delete(listener);
        if (listeners && listeners.size === 0) this.taskWaiters.delete(taskId);
      };

      const finish = (task: DurableTask, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ task, timedOut });
      };

      const listener: TaskWaitListener = (task) => {
        if (TERMINAL_TASK_STATUSES.has(task.status)) finish(task, false);
      };

      let listeners = this.taskWaiters.get(taskId);
      if (!listeners) {
        listeners = new Set<TaskWaitListener>();
        this.taskWaiters.set(taskId, listeners);
      }
      listeners.add(listener);

      // Close the registration race: the task may have completed between the
      // initial snapshot and listener insertion.
      const refreshed = this.getTask(taskId);
      if (refreshed && TERMINAL_TASK_STATUSES.has(refreshed.status)) {
        finish(refreshed, false);
        return;
      }

      timer = setTimeout(() => {
        const current = this.getTask(taskId) || initial;
        finish(current, !TERMINAL_TASK_STATUSES.has(current.status));
      }, timeoutMs);
    });
  }

  public claimTask(
    deviceId: string,
    supportedCapabilities: string[],
    leaseDurationMs?: number
  ): DurableTask | undefined {
    this.recoverStaleTasks();

    const eligibleTasks = Array.from(this.tasks.values())
      .filter(t => t.status === 'queued' && supportedCapabilities.includes(t.capability))
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));

    if (eligibleTasks.length === 0) return undefined;
    return this.claimTaskById(eligibleTasks[0].taskId, deviceId, leaseDurationMs);
  }

  public claimTaskById(taskId: string, deviceId: string, leaseDurationMs?: number): DurableTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'queued') return undefined;

    const now = Date.now();
    const attempt = this.createAttempt(task, deviceId, now);
    if (!attempt) return undefined;

    const duration = leaseDurationMs || this.defaultLeaseDurationMs;
    task.status = 'claimed';
    task.lease = {
      claimedBy: deviceId,
      claimedAt: now,
      leaseExpiresAt: now + duration,
      lastHeartbeatAt: now
    };

    this.saveTask(task);
    return task;
  }

  public acknowledgeTask(taskId: string, deviceId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'claimed' || task.lease?.claimedBy !== deviceId) {
      return false;
    }

    const attempt = this.ensureActiveAttempt(task, deviceId);
    if (!attempt || attempt.claimedBy !== deviceId) return false;

    const now = Date.now();
    task.status = 'acknowledged';
    attempt.status = 'acknowledged';
    attempt.acknowledgedAt = now;
    if (task.lease) {
      task.lease.acknowledgedAt = now;
      task.lease.lastHeartbeatAt = now;
    }
    this.saveTask(task);
    return true;
  }

  public startTask(taskId: string, deviceId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    const now = Date.now();

    if (task.lease) {
      // A claimed task has an authoritative owner. No caller — including an
      // internal backend — may take over that active attempt implicitly.
      if (task.lease.claimedBy !== deviceId) return false;
      if (task.status !== 'claimed' && task.status !== 'acknowledged' && task.status !== 'running') return false;
    } else {
      // Gateway-internal backends historically start immediately after durable
      // submission and therefore do not perform the local-agent claim handshake.
      // Preserve that path, but require local-device tasks to claim first.
      if (task.backend === 'local' || task.status !== 'queued') return false;

      const created = this.createAttempt(task, deviceId, now);
      if (!created) return false;
      task.lease = {
        claimedBy: deviceId,
        claimedAt: now,
        leaseExpiresAt: now + this.defaultLeaseDurationMs,
        lastHeartbeatAt: now
      };
    }

    const attempt = this.ensureActiveAttempt(task, deviceId);
    if (!attempt || attempt.claimedBy !== deviceId) return false;

    if (task.status !== 'running') {
      task.status = 'running';
      task.startedAt = task.startedAt ?? now;
      attempt.status = 'running';
      attempt.startedAt = attempt.startedAt ?? now;
    } else {
      // TASK_PROGRESS can arrive many times. Starting an already-running attempt
      // is idempotent and must not rewrite its original start timestamp.
      attempt.status = 'running';
      attempt.startedAt = attempt.startedAt ?? task.startedAt ?? now;
    }

    task.lease.lastHeartbeatAt = now;
    task.lease.leaseExpiresAt = now + this.defaultLeaseDurationMs;
    this.saveTask(task);
    return true;
  }

  public renewLease(taskId: string, deviceId: string, extensionMs?: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !task.lease || task.lease.claimedBy !== deviceId) {
      return false;
    }

    if (task.status !== 'claimed' && task.status !== 'acknowledged' && task.status !== 'running') {
      return false;
    }

    const attempt = this.ensureActiveAttempt(task, deviceId);
    if (!attempt || attempt.claimedBy !== deviceId) return false;

    const now = Date.now();
    task.lease.lastHeartbeatAt = now;
    task.lease.leaseExpiresAt = now + (extensionMs || this.defaultLeaseDurationMs);
    this.saveTask(task);
    return true;
  }

  public appendLogs(taskId: string, lines: string[]): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    for (const line of lines) {
      task.logs.push(`[${new Date().toISOString()}] ${line}`);
    }
    this.saveTask(task);
  }

  public addArtifact(taskId: string, artifact: TaskArtifactSummary): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (!task.artifacts.some(existing => existing.id === artifact.id)) {
      task.artifacts.push(artifact);
      this.saveTask(task);
    }
  }

  public completeTask(taskId: string, result: any): boolean {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return false;

    this.finishActiveAttempt(task, 'succeeded');
    task.status = 'succeeded';
    task.result = result;
    task.completedAt = Date.now();
    task.lease = undefined;
    this.saveTask(task);
    return true;
  }

  public failTask(
    taskId: string,
    error: { code: string; message: string; details?: any },
    options?: { retryable?: boolean }
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return false;

    this.finishActiveAttempt(task, 'failed', error);
    const isRetryable = options?.retryable !== false && task.retryPolicy.retryCount < task.retryPolicy.maxRetries;

    if (isRetryable) {
      task.retryPolicy.retryCount++;
      task.lease = undefined;
      task.completedAt = undefined;
      if (!task.metadata) task.metadata = {};
      task.metadata.lastRetryError = error;

      // File-backed local runtimes can honor the requested backoff timer. Durable
      // cloud runtimes requeue immediately so a process eviction cannot strand a
      // task in an in-memory "retrying" timer that will never fire.
      if (this.storageAdapter) {
        task.status = 'queued';
        task.logs.push(`[RETRY] Requeued durably after failure (attempt ${task.retryPolicy.retryCount}/${task.retryPolicy.maxRetries}): ${error.message}`);
      } else {
        task.status = 'retrying';
        setTimeout(() => {
          const t = this.tasks.get(taskId);
          if (t && t.status === 'retrying') {
            t.status = 'queued';
            this.saveTask(t);
          }
        }, task.retryPolicy.backoffMs * task.retryPolicy.retryCount);
      }
    } else {
      task.status = 'failed';
      task.error = error;
      task.completedAt = Date.now();
      task.lease = undefined;
    }

    this.saveTask(task);
    return true;
  }

  public failTaskTerminal(taskId: string, error: { code: string; message: string; details?: any }): boolean {
    return this.failTask(taskId, error, { retryable: false });
  }

  public cancelTask(taskId: string, reason = 'User requested cancellation'): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    this.finishActiveAttempt(task, 'cancelled', { code: 'TASK_CANCELLED', message: reason });
    task.status = 'cancelled';
    task.error = { code: 'TASK_CANCELLED', message: reason };
    task.completedAt = Date.now();
    task.lease = undefined;
    this.saveTask(task);
    return true;
  }

  public setExternalRun(taskId: string, externalRun: any): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.externalRun = externalRun;
    this.saveTask(task);
    return true;
  }

  public updateTask(taskId: string, updates: Partial<DurableTask>): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    Object.assign(task, updates);
    this.normalizeAttemptLedger(task);
    this.saveTask(task);
    return true;
  }

  public recoverStaleTasks(): { recoveredCount: number; failedCount: number } {
    const now = Date.now();
    let recoveredCount = 0;
    let failedCount = 0;

    for (const task of this.tasks.values()) {
      // External durable jobs (such as Kaggle runs) must not be blindly requeued on local worker lease timeout.
      if (task.externalRun && task.externalRun.provider === 'kaggle') {
        continue;
      }

      if (
        (task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running') &&
        task.lease &&
        now > task.lease.leaseExpiresAt
      ) {
        const claimedBy = task.lease.claimedBy;
        task.logs.push(`[STALE_DETECTION] Lease expired at ${new Date(task.lease.leaseExpiresAt).toISOString()} for worker ${claimedBy}`);
        this.ensureActiveAttempt(task, claimedBy);
        this.finishActiveAttempt(task, 'interrupted', {
          code: 'TASK_LEASE_EXPIRED',
          message: `Task lease expired without heartbeat or completion from worker ${claimedBy}`
        });

        if (task.retryPolicy.requeueOnStale && task.retryPolicy.retryCount < task.retryPolicy.maxRetries) {
          task.retryPolicy.retryCount++;
          task.status = 'queued';
          task.lease = undefined;
          recoveredCount++;
        } else {
          task.status = 'stale';
          task.error = {
            code: 'TASK_STALE',
            message: `Task lease expired without heartbeat or completion from worker ${claimedBy}`
          };
          task.completedAt = now;
          task.lease = undefined;
          failedCount++;
        }
        this.saveTask(task);
      }
    }

    return { recoveredCount, failedCount };
  }

  public listTasks(filter?: {
    status?: TaskStatus;
    backend?: string;
    capability?: string;
    limit?: number;
  }): DurableTask[] {
    let list = Array.from(this.tasks.values());

    if (filter?.status) {
      list = list.filter(t => t.status === filter.status);
    }
    if (filter?.backend) {
      list = list.filter(t => t.backend === filter.backend);
    }
    if (filter?.capability) {
      list = list.filter(t => t.capability === filter.capability);
    }

    list.sort((a, b) => b.createdAt - a.createdAt);

    if (filter?.limit) {
      list = list.slice(0, filter.limit);
    }

    return list;
  }
}