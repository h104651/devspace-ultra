import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CreateTaskOptions, DurableTask, TaskStatus, TaskArtifactSummary } from '../types/task';
import { ScopeChecker } from '../security/scope-checker';
import { IStorageAdapter } from './storage-adapter.interface';

export class TaskStore {
  private tasksDir?: string;
  private tasks: Map<string, DurableTask> = new Map();
  private defaultLeaseDurationMs: number;
  private storageAdapter?: IStorageAdapter;

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
    if (durable) this.tasks.set(taskId, durable);
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

    task.status = 'acknowledged';
    if (task.lease) {
      task.lease.acknowledgedAt = Date.now();
      task.lease.lastHeartbeatAt = Date.now();
    }
    this.saveTask(task);
    return true;
  }

  public startTask(taskId: string, deviceId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.status = 'running';
    task.startedAt = Date.now();
    if (task.lease) {
      task.lease.lastHeartbeatAt = Date.now();
      task.lease.leaseExpiresAt = Date.now() + this.defaultLeaseDurationMs;
    } else {
      task.lease = {
        claimedBy: deviceId,
        claimedAt: Date.now(),
        leaseExpiresAt: Date.now() + this.defaultLeaseDurationMs,
        lastHeartbeatAt: Date.now()
      };
    }
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
    if (!task) return false;

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
    if (!task) return false;

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
