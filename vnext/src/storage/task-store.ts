import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  CreateTaskOptions,
  DurableTask,
  TaskStatus,
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  TaskArtifactSummary,
  TaskAttempt,
  TaskAttemptStatus
} from '../types/task';
import { ScopeChecker } from '../security/scope-checker';
import { isSideEffectCapability } from '../local-agent/capabilities';
import { IStorageAdapter, TaskInventorySource, DeviceAdmissionState } from './storage-adapter.interface';

const ACTIVE_ATTEMPT_STATUSES = new Set<TaskAttemptStatus>(['claimed', 'acknowledged', 'running']);
const TASK_LOG_MAX_LINES = 2000;
const TASK_LOG_MAX_ENTRY_BYTES = 4096;
const TASK_LOG_RETENTION_MARKER = `[LOG_RETENTION] Older task logs truncated; retaining newest ${TASK_LOG_MAX_LINES - 1} entries`;
const TASK_LOG_LINE_TRUNCATION_MARKER = ' …[LOG_LINE_TRUNCATED]';

type TaskWaitListener = (task: DurableTask) => void;

export interface TaskWaitResult {
  task: DurableTask;
  timedOut: boolean;
}

export class TaskStore {
  private tasksDir?: string;
  private admissionDir?: string;
  private memoryAdmissions = new Map<string, DeviceAdmissionState>();
  private tasks: Map<string, DurableTask> = new Map();
  private defaultLeaseDurationMs: number;
  private storageAdapter?: IStorageAdapter;
  // Never resume local dispatch in a process that has lost durable state.
  private localPersistenceFailed = false;
  private inventoryPersistenceUnconfirmed = false;
  private taskWaiters: Map<string, Set<TaskWaitListener>> = new Map();

  constructor(storageDir?: string, defaultLeaseDurationMs = 60000, storageAdapter?: IStorageAdapter) {
    this.defaultLeaseDurationMs = defaultLeaseDurationMs;
    this.storageAdapter = storageAdapter;
    if (storageDir && storageDir !== ':memory:') {
      this.tasksDir = path.join(storageDir, 'tasks');
      this.admissionDir = path.join(storageDir, 'device-admission');
      try {
        if (!fs.existsSync(this.tasksDir)) {
          fs.mkdirSync(this.tasksDir, { recursive: true });
        }
        fs.mkdirSync(this.admissionDir, { recursive: true });
        this.loadAll();
      } catch { this.blockLocalDispatch(); }
    }
  }

  /** Fail closed after an unreadable or unconfirmed durable task state. */
  public blockLocalDispatch(): void {
    this.localPersistenceFailed = true;
  }

  public hydrate(tasks: DurableTask[]): void {
    for (const task of tasks || []) {
      if (task?.taskId) {
        this.normalizeAttemptLedger(task);
        this.normalizeLogEntries(task);
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
            this.normalizeLogEntries(task);
            this.tasks.set(task.taskId, task);
          } catch (err) {
            this.blockLocalDispatch();
            console.error(`Failed to load task file ${file}:`, err);
          }
        }
      }
    } catch (err) {
      this.blockLocalDispatch();
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

  private truncateLogEntry(value: any): string {
    const text = String(value ?? '');
    if (Buffer.byteLength(text, 'utf8') <= TASK_LOG_MAX_ENTRY_BYTES) return text;

    const suffixBytes = Buffer.byteLength(TASK_LOG_LINE_TRUNCATION_MARKER, 'utf8');
    const maxPrefixBytes = Math.max(0, TASK_LOG_MAX_ENTRY_BYTES - suffixBytes);
    const prefixChars: string[] = [];
    let prefixBytes = 0;
    for (const char of text) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (prefixBytes + charBytes > maxPrefixBytes) break;
      prefixChars.push(char);
      prefixBytes += charBytes;
    }
    return `${prefixChars.join('')}${TASK_LOG_LINE_TRUNCATION_MARKER}`;
  }

  private normalizeLogEntries(task: DurableTask): void {
    if (!Array.isArray(task.logs)) task.logs = [];
    task.logs = task.logs.map(line => this.truncateLogEntry(line));
    this.enforceLogRetention(task);
  }

  private enforceLogRetention(task: DurableTask): void {
    if (!Array.isArray(task.logs)) task.logs = [];
    if (task.logs.length <= TASK_LOG_MAX_LINES) return;
    const newest = task.logs.slice(-(TASK_LOG_MAX_LINES - 1));
    task.logs = [TASK_LOG_RETENTION_MARKER, ...newest];
  }

  private persistLocalTask(task: DurableTask): void {
    if (this.localPersistenceFailed) throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Local dispatch is blocked; reconcile durable state before restart.');
    try {
      if (this.storageAdapter) {
        if (typeof this.storageAdapter.saveTaskSync !== 'function') {
          throw new Error('Synchronous local task persistence is not supported by the configured adapter');
        }
        this.storageAdapter.saveTaskSync(task);
      }
      if (this.tasksDir) {
        fs.mkdirSync(this.tasksDir, { recursive: true });
        const destination = path.join(this.tasksDir, `${task.taskId}.json`);
        const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
        try {
          const fd = fs.openSync(temporary, 'wx', 0o600);
          try {
            fs.writeFileSync(fd, JSON.stringify(task, null, 2), 'utf-8');
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          fs.renameSync(temporary, destination);
          // Windows does not support portable directory fsync via Node.
          if (process.platform !== 'win32') {
            const dirFd = fs.openSync(this.tasksDir, 'r');
            try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
          }
        } finally {
          // A failed replacement must leave the preceding JSON file intact.
          try { fs.unlinkSync(temporary); } catch {}
        }
      }
    } catch {
      this.localPersistenceFailed = true;
      // The operation may already have reached storage. Do not roll back to
      // queued or report success based on uncommitted memory.
      throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Local task state could not be confirmed; dispatch is blocked until reconciliation.');
    }
  }

  private saveTask(task: DurableTask) {
    this.enforceLogRetention(task);
    task.updatedAt = Date.now();

    if (task.backend === 'local') {
      try {
        this.persistLocalTask(task);
      } catch (err) {
        // Do not expose an in-memory success as a durable success. The stored
        // record is still authoritative and must be reconciled by an operator.
        task.status = 'stale';
        task.error = { code: 'LOCAL_TASK_PERSISTENCE_UNAVAILABLE', message: 'Local task persistence is unconfirmed; manual reconciliation required.' };
        task.result = undefined;
        task.completedAt = Date.now();
        throw err;
      }
      this.notifyTaskChanged(task);
      return;
    }

    if (this.tasksDir) {
      try {
        if (!fs.existsSync(this.tasksDir)) {
          fs.mkdirSync(this.tasksDir, { recursive: true });
        }
        const taskPath = path.join(this.tasksDir, `${task.taskId}.json`);
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
      } catch { this.inventoryPersistenceUnconfirmed = true; }
    }

    if (this.storageAdapter) {
      void this.storageAdapter.saveTask(task).catch(err => {
        this.inventoryPersistenceUnconfirmed = true;
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
    let attempt = this.getActiveAttempt(task);
    if (
      !attempt &&
      task.lease?.claimedBy &&
      (task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running')
    ) {
      attempt = this.ensureActiveAttempt(task, task.lease.claimedBy);
    }
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

  /** A persistent admission fence, not proof that a host process has stopped. */
  public getDeviceAdmission(deviceId: string): DeviceAdmissionState {
    if (this.localPersistenceFailed) throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Local dispatch is blocked.');
    if (!deviceId || typeof deviceId !== 'string') throw new Error('INVALID_ARGUMENT: Device ID required.');
    try {
      let state: DeviceAdmissionState | undefined;
      if (this.storageAdapter) {
        if (!this.storageAdapter.getDeviceAdmissionSync || !this.storageAdapter.saveDeviceAdmissionSync) {
          throw new Error('Device admission persistence unavailable');
        }
        state = this.storageAdapter.getDeviceAdmissionSync(deviceId);
      } else if (this.admissionDir) {
        // Absence of the directory is a storage failure, not an open device.
        if (!fs.statSync(this.admissionDir).isDirectory()) throw new Error('Admission directory unavailable');
        const file = path.join(this.admissionDir, crypto.createHash('sha256').update(deviceId).digest('hex') + '.json');
        try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (err: any) { if (err.code !== 'ENOENT') throw err; }
      } else {
        state = this.memoryAdmissions.get(deviceId);
      }
      if (state === undefined) return { deviceId, closed: false, revision: 'initial', updatedAt: 0 };
      if (state.deviceId !== deviceId || typeof state.closed !== 'boolean' ||
          !/^[a-f0-9-]{36}$/.test(state.revision) || !Number.isSafeInteger(state.updatedAt) || state.updatedAt <= 0) {
        throw new Error('Invalid admission state');
      }
      return { ...state };
    } catch {
      this.blockLocalDispatch();
      throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Device admission state could not be confirmed.');
    }
  }

  public setDeviceAdmission(deviceId: string, closed: boolean, expectedRevision: string): DeviceAdmissionState {
    const current = this.getDeviceAdmission(deviceId);
    if (expectedRevision !== current.revision) throw new Error('DEVICE_ADMISSION_REVISION_CONFLICT: Read current state and retry explicitly.');
    if (current.closed === closed) return current;
    if (!closed) {
      const inventory = this.taskInventory({ backend: 'local', targetDeviceId: deviceId, status: 'active', limit: 1 });
      if (inventory.total || inventory.summary.staleLocalCount || inventory.summary.quarantinedLocalCount) {
        throw new Error('DEVICE_RESUME_BLOCKED: Reconcile active, stale and quarantined work first.');
      }
    }
    const state = { deviceId, closed, revision: crypto.randomUUID(), updatedAt: Date.now() };
    try {
      if (this.storageAdapter) {
        this.storageAdapter.saveDeviceAdmissionSync!(state);
      } else if (this.admissionDir) {
        const file = path.join(this.admissionDir, crypto.createHash('sha256').update(deviceId).digest('hex') + '.json');
        const tmp = file + '.' + crypto.randomUUID() + '.tmp';
        try {
          const fd = fs.openSync(tmp, 'wx', 0o600);
          try { fs.writeFileSync(fd, JSON.stringify(state), 'utf8'); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
          fs.renameSync(tmp, file);
          if (process.platform !== 'win32') {
            const dir = fs.openSync(this.admissionDir, 'r');
            try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
          }
        } finally { try { fs.unlinkSync(tmp); } catch {} }
      } else {
        this.memoryAdmissions.set(deviceId, state);
      }
      const persisted = this.getDeviceAdmission(deviceId);
      if (persisted.revision !== state.revision || persisted.closed !== closed) throw new Error('Admission write unconfirmed');
      return persisted;
    } catch {
      this.blockLocalDispatch();
      throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Device admission transition unconfirmed; dispatch blocked.');
    }
  }

  public createTask<TPayload = any>(options: CreateTaskOptions<TPayload>): DurableTask<TPayload> {
    if (options.backend === 'local' && options.targetDeviceId && this.getDeviceAdmission(options.targetDeviceId.trim()).closed) {
      throw new Error('DEVICE_ADMISSION_CLOSED: Device is draining; no new local task accepted.');
    }
    const taskId = options.taskId || `task-${crypto.randomBytes(8).toString('hex')}`;
    const requiredScope = options.requiredScope || ScopeChecker.getRequiredScopeForCapability(options.capability);

    const metadata = options.metadata ? { ...options.metadata } : undefined;
    if (metadata) delete metadata.executionCancellation;
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
        requeueOnStale: options.requeueOnStale ?? true
      },
      attempts: [],
      artifacts: [],
      logs: [],
      targetDeviceId: options.targetDeviceId ? options.targetDeviceId.trim() : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata
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
      this.normalizeLogEntries(durable);
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

  private executionAdmissionMatches(task: DurableTask, sessionId?: string, policyRevision?: string): boolean {
    if (task.backend !== 'local' || (task.capability !== 'local:run_tests' && task.capability !== 'local:build_project' && task.capability !== 'local:git_read')) return true;
    const admission = task.metadata?.executionAdmission;
    return !!sessionId && !!policyRevision && admission?.sessionId === sessionId && admission?.policyRevision === policyRevision;
  }

  public claimTask(
    deviceId: string,
    supportedCapabilities: string[],
    leaseDurationMs?: number,
    sessionId?: string,
    supportsAttemptFencing = true,
    executionPolicyRevision?: string
  ): DurableTask | undefined {
    if (this.localPersistenceFailed) throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Local dispatch is blocked until reconciliation.');
    if (this.getDeviceAdmission(deviceId).closed) return undefined;
    this.recoverStaleTasks();

    // Queued execution may never inherit a later session or more permissive policy.
    for (const task of this.tasks.values()) {
      if (task.status === 'queued' && task.targetDeviceId === deviceId && !this.executionAdmissionMatches(task, sessionId, executionPolicyRevision)) {
        this.failTaskTerminal(task.taskId, { code: 'EXECUTION_ADMISSION_EXPIRED', message: 'Execution session or policy changed before dispatch; submit a new reviewed request.' });
      }
    }
    const eligibleTasks = Array.from(this.tasks.values())
      .filter(t => {
        if (t.status !== 'queued') return false;
        if (!supportedCapabilities.includes(t.capability)) return false;
        if (t.backend === 'local') {
          if (!t.targetDeviceId || t.targetDeviceId !== deviceId) return false;
          // Legacy wire clients cannot distinguish multiple executions of one task.
          if (!supportsAttemptFencing && (t.attempts?.length || 0) > 0) return false;
        }
        return true;
      })
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));

    if (eligibleTasks.length === 0) return undefined;
    return this.claimTaskById(eligibleTasks[0].taskId, deviceId, leaseDurationMs, sessionId, executionPolicyRevision);
  }

  public claimTaskById(
    taskId: string,
    deviceId: string,
    leaseDurationMs?: number,
    sessionId?: string,
    executionPolicyRevision?: string
  ): DurableTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'queued') return undefined;
    if (!this.executionAdmissionMatches(task, sessionId, executionPolicyRevision)) return undefined;
    if (task.backend === 'local' && this.getDeviceAdmission(deviceId).closed) return undefined;
    if (task.backend === 'local' && (!task.targetDeviceId || task.targetDeviceId !== deviceId)) return undefined;
    if (task.backend === 'local' && this.localPersistenceFailed) throw new Error('LOCAL_TASK_PERSISTENCE_UNAVAILABLE: Local dispatch is blocked until reconciliation.');

    const now = Date.now();
    const attempt = this.createAttempt(task, deviceId, now);
    if (!attempt) return undefined;

    const duration = leaseDurationMs || this.defaultLeaseDurationMs;
    task.status = 'claimed';
    task.lease = {
      claimedBy: deviceId,
      claimedSessionId: sessionId,
      claimedAt: now,
      leaseExpiresAt: now + duration,
      lastHeartbeatAt: now
    };

    this.saveTask(task);
    return task;
  }

  public migrateLegacyUnassignedTasks(options?: { trustedLegacyDeviceId?: string } | string[]): { migrated: number; quarantined: number; failedAmbiguous: number } {
    let migrated = 0;
    let quarantined = 0;
    let failedAmbiguous = 0;

    let trustedLegacyDeviceId: string | undefined = undefined;
    if (options) {
      if (Array.isArray(options)) {
        // If an array was passed, do NOT assume knownDeviceIds[0] is the owner unless trusted
        // Only accept if exactly one device is passed and it was explicitly designated
      } else if (typeof options === 'object') {
        trustedLegacyDeviceId = options.trustedLegacyDeviceId;
      }
    }

    for (const task of this.tasks.values()) {
      if (task.backend === 'local' && !task.targetDeviceId) {
        // 1. Verifiable historical evidence: Lease or Attempt claimant
        const priorClaimant = task.lease?.claimedBy || (task.attempts && [...task.attempts].reverse().find(a => a.claimedBy)?.claimedBy);
        if (priorClaimant) {
          task.targetDeviceId = priorClaimant;
          this.saveTask(task);
          migrated++;
          continue;
        }

        // 2. Explicit trusted legacy device ID provided by admin / configuration
        if (trustedLegacyDeviceId) {
          task.targetDeviceId = trustedLegacyDeviceId;
          this.saveTask(task);
          migrated++;
          continue;
        }

        // 3. Unproven ownership: MUST remain in unclaimable quarantine state in 'queued'
        // DO NOT auto-bind to any device simply because it connected first or was the sole registered device.
        // DO NOT mark as failed unconditionally.
        // Because claimTask() and claimTaskById() strictly require task.targetDeviceId === deviceId,
        // this task can NEVER be claimed by any agent until explicitly assigned.
        if (ACTIVE_TASK_STATUSES.has(task.status)) {
          quarantined++;
        }
      }
    }
    return { migrated, quarantined, failedAmbiguous };
  }

  public assignQuarantinedTasks(targetDeviceId: string, taskIds: string[]): { assigned: number; taskIds: string[] } {
    let assigned = 0;
    const assignedTaskIds: string[] = [];
    if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      return { assigned: 0, taskIds: [] };
    }
    if (this.getDeviceAdmission(targetDeviceId).closed) throw new Error('DEVICE_ADMISSION_CLOSED: Cannot assign quarantined work to a draining device.');
    const targetSet = new Set(taskIds);
    const now = Date.now();

    for (const task of this.tasks.values()) {
      // Must be local backend, unassigned, active (non-terminal), and explicitly in taskIds
      if (task.backend === 'local' && !task.targetDeviceId && ACTIVE_TASK_STATUSES.has(task.status)) {
        if (!targetSet.has(task.taskId)) {
          continue;
        }
        // Guard: Cannot reassign a task that currently has an active unexpired lease held by a different claimant
        if (task.lease && task.lease.leaseExpiresAt > now && task.lease.claimedBy && task.lease.claimedBy !== targetDeviceId) {
          continue;
        }
        task.targetDeviceId = targetDeviceId;
        this.saveTask(task);
        assigned++;
        assignedTaskIds.push(task.taskId);
      }
    }
    return { assigned, taskIds: assignedTaskIds };
  }

  public ownsLocalAttempt(taskId: string, deviceId: string, sessionId: string, attemptId: string | undefined, supportsAttemptFencing: boolean): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.backend !== 'local' || !task.lease || task.lease.claimedBy !== deviceId ||
        task.lease.claimedSessionId !== sessionId || !task.activeAttemptId ||
        !['claimed', 'acknowledged', 'running'].includes(task.status)) return false;
    if (supportsAttemptFencing || attemptId !== undefined) return attemptId === task.activeAttemptId;
    // Legacy wire messages are safe only on a first, non-replayed execution.
    return (task.attempts?.length || 0) === 1;
  }

  public acknowledgeTask(taskId: string, deviceId: string, sessionId?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'claimed' || task.lease?.claimedBy !== deviceId) {
      return false;
    }
    if (sessionId && task.lease?.claimedSessionId && task.lease.claimedSessionId !== sessionId) {
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

  public startTask(taskId: string, deviceId: string, sessionId?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    const now = Date.now();

    if (task.lease) {
      // A claimed task has an authoritative owner. No caller — including an
      // internal backend — may take over that active attempt implicitly.
      if (task.lease.claimedBy !== deviceId) return false;
      if (sessionId && task.lease.claimedSessionId && task.lease.claimedSessionId !== sessionId) return false;
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
        claimedSessionId: sessionId,
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

  public renewLease(taskId: string, deviceId: string, extensionMs?: number, sessionId?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || !task.lease || task.lease.claimedBy !== deviceId) {
      return false;
    }
    if (sessionId && task.lease.claimedSessionId && task.lease.claimedSessionId !== sessionId) {
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
      task.logs.push(this.truncateLogEntry(`[${new Date().toISOString()}] ${line}`));
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

  public completeTask(taskId: string, result: any, deviceId?: string, sessionId?: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return false;
    if (deviceId && task.lease && task.lease.claimedBy !== deviceId) return false;
    if (sessionId && task.lease?.claimedSessionId && task.lease.claimedSessionId !== sessionId) return false;

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
    options?: { retryable?: boolean; deviceId?: string; sessionId?: string }
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task || TERMINAL_TASK_STATUSES.has(task.status)) return false;
    if (options?.deviceId && task.lease && task.lease.claimedBy !== options.deviceId) return false;
    if (options?.sessionId && task.lease?.claimedSessionId && task.lease.claimedSessionId !== options.sessionId) return false;

    this.finishActiveAttempt(task, 'failed', error);
    const isRetryable = !(task.backend === 'local' && isSideEffectCapability(task.capability)) &&
      options?.retryable !== false && task.retryPolicy.retryCount < task.retryPolicy.maxRetries;

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
        task.logs.push(this.truncateLogEntry(`[RETRY] Requeued durably after failure (attempt ${task.retryPolicy.retryCount}/${task.retryPolicy.maxRetries}): ${error.message}`));
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

  public failTasksForSupersededSession(
    deviceId: string,
    supersededSessionId: string,
    reason = 'Session superseded'
  ): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.backend === 'local' &&
        task.lease?.claimedBy === deviceId &&
        task.lease?.claimedSessionId === supersededSessionId &&
        (task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running')
      ) {
        if (isSideEffectCapability(task.capability)) {
          this.finishActiveAttempt(task, 'interrupted', {
            code: 'SESSION_SUPERSEDED_MUTATION_UNCERTAIN',
            message: `${reason}: Task execution interrupted while side effects may have been applied. Manual recovery required.`
          });
          task.status = 'stale';
          task.error = {
            code: 'SESSION_SUPERSEDED_MUTATION_UNCERTAIN',
            message: `${reason}: Task execution interrupted while side effects may have been applied. Manual recovery required.`
          };
          task.completedAt = Date.now();
          task.lease = undefined;
          this.saveTask(task);
          count++;
        } else {
          this.finishActiveAttempt(task, 'interrupted', {
            code: 'SESSION_SUPERSEDED_RESET',
            message: `${reason}: Read-only task requeued.`
          });
          task.status = 'queued';
          task.lease = undefined;
          this.saveTask(task);
          count++;
        }
      }
    }
    return count;
  }

  public failTaskTerminal(taskId: string, error: { code: string; message: string; details?: any }): boolean {
    return this.failTask(taskId, error, { retryable: false });
  }

  private isExecutionTask(task: DurableTask): boolean {
    return task.backend === 'local' && (task.capability === 'local:run_tests' || task.capability === 'local:build_project');
  }

  public requestExecutionCancellation(taskId: string, deviceId: string, sessionId: string, attemptId: string) {
    const task = this.tasks.get(taskId);
    if (!task || !this.isExecutionTask(task) || !attemptId || !this.ownsLocalAttempt(taskId, deviceId, sessionId, attemptId, true)) {
      throw new Error('EXECUTION_CANCEL_NOT_ACTIVE: Exact live execution attempt required.');
    }
    const previous = task.metadata?.executionCancellation;
    if (previous) {
      if (previous.sessionId !== sessionId || previous.attemptId !== attemptId || previous.confirmedAt) {
        throw new Error('EXECUTION_CANCEL_CONFLICT: Existing request is not current.');
      }
      return previous.requestId as string;
    }
    const requestId = crypto.randomUUID();
    task.metadata = { ...task.metadata, executionCancellation: { requestId, sessionId, attemptId, requestedAt: Date.now() } };
    this.saveTask(task);
    return requestId;
  }

  public getPendingExecutionCancellation(taskId: string, deviceId: string, sessionId: string, attemptId: string) {
    const task = this.tasks.get(taskId);
    const request = task?.metadata?.executionCancellation;
    if (!task || !this.isExecutionTask(task) || !request || request.confirmedAt ||
        request.sessionId !== sessionId || request.attemptId !== attemptId ||
        !this.ownsLocalAttempt(taskId, deviceId, sessionId, attemptId, true)) return undefined;
    return { taskId, attemptId, requestId: request.requestId as string };
  }

  public confirmExecutionCancellation(taskId: string, deviceId: string, sessionId: string, attemptId: string, requestId: string): boolean {
    const pending = this.getPendingExecutionCancellation(taskId, deviceId, sessionId, attemptId);
    if (!pending || !requestId || pending.requestId !== requestId) return false;
    const task = this.tasks.get(taskId)!;
    const error = { code: 'TASK_CANCELLED', message: 'Agent confirmed native process-tree cancellation.' };
    task.metadata!.executionCancellation.confirmedAt = Date.now();
    this.finishActiveAttempt(task, 'cancelled', error);
    task.status = 'cancelled';
    task.error = error;
    task.completedAt = Date.now();
    task.lease = undefined;
    this.saveTask(task);
    return true;
  }

  public cancelTask(taskId: string, reason = 'User requested cancellation'): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return false;
    }

    // Generic cancellation has no agent acknowledgement or process-tree drain proof.
    // Queued execution can be cancelled; dispatched execution must remain auditable.
    if (task.backend === 'local' && (task.capability === 'local:run_tests' || task.capability === 'local:build_project' || task.capability === 'local:git_read') &&
      (task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running')) {
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
    if (updates.logs !== undefined) this.normalizeLogEntries(task);
    this.saveTask(task);
    return true;
  }

  public recoverStaleTasks(): { recoveredCount: number; failedCount: number } {
    const now = Date.now();
    let recoveredCount = 0;
    let failedCount = 0;

    for (const task of this.tasks.values()) {
      // Kaggle is an external remote backend. Its provider state, not a local
      // worker lease, is authoritative — including legacy rows that predate
      // externalRun persistence and can only be identified by backend identity.
      if (task.backend === 'kaggle' || task.externalRun?.provider === 'kaggle') {
        continue;
      }

      if (
        (task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running') &&
        task.lease &&
        now > task.lease.leaseExpiresAt
      ) {
        const claimedBy = task.lease.claimedBy;
        task.logs.push(this.truncateLogEntry(`[STALE_DETECTION] Lease expired at ${new Date(task.lease.leaseExpiresAt).toISOString()} for worker ${claimedBy}`));
        this.ensureActiveAttempt(task, claimedBy);
        this.finishActiveAttempt(task, 'interrupted', {
          code: 'TASK_LEASE_EXPIRED',
          message: `Task lease expired without heartbeat or completion from worker ${claimedBy}`
        });

        if (task.backend === 'local' && isSideEffectCapability(task.capability)) {
          // Dispatch may have reached the executor before ACK or RUNNING was persisted.
          // No automatic replay of a potentially applied local mutation.
          task.status = 'stale';
          task.error = {
            code: 'MUTATION_UNCERTAIN_ON_STALE',
            message: `Task lease expired after dispatch of mutating capability '${task.capability}'. Manual recovery required.`
          };
          task.completedAt = now;
          task.lease = undefined;
          failedCount++;
        } else if (task.retryPolicy.requeueOnStale && task.retryPolicy.retryCount < task.retryPolicy.maxRetries) {
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

  /**
   * Read-only, bounded, revision-checked observation. Not a maintenance lock.
   * A filter never narrows the global counts used to evaluate gateway inventory.
   */
  public taskInventory(args: any = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).some(key => !['backend', 'status', 'targetDeviceId', 'offset', 'limit', 'snapshotRevision'].includes(key))) {
      throw new Error('INVALID_ARGUMENT: Invalid task inventory filter.');
    }
    const backend = args.backend ?? 'all';
    const status = args.status ?? 'all';
    const targetDeviceId = args.targetDeviceId;
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
    if (!['all', 'local', 'kaggle', 'browser', 'swarm'].includes(backend) ||
        !['all', 'active', 'stale', 'quarantined'].includes(status) ||
        (targetDeviceId !== undefined && (!validId(targetDeviceId) || (backend !== 'all' && backend !== 'local'))) ||
        !Number.isInteger(offset) || offset < 0 || offset > 10000 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (args.snapshotRevision !== undefined && (typeof args.snapshotRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.snapshotRevision))) ||
        (offset > 0 && !args.snapshotRevision)) {
      throw new Error('INVALID_ARGUMENT: Inventory requires bounded filters and a revision for subsequent pages.');
    }
    if (this.localPersistenceFailed || this.inventoryPersistenceUnconfirmed) {
      throw new Error('INVENTORY_UNAVAILABLE: Durable task persistence is unconfirmed.');
    }
    const cap = 10000;
    const included = (task: TaskInventorySource) => ACTIVE_TASK_STATUSES.has(task.status) ||
      (task.backend === 'local' && task.status === 'stale');
    let source: TaskInventorySource[] = [];
    if (this.storageAdapter) {
      if (!this.storageAdapter.readTaskInventorySync) throw new Error('INVENTORY_UNAVAILABLE: Durable snapshot not supported.');
      source = this.storageAdapter.readTaskInventorySync(cap + 1);
    } else {
      for (const task of this.tasks.values()) {
        if (included(task)) source.push(task);
        if (source.length > cap) break;
      }
    }
    if (source.length > cap) throw new Error('INVENTORY_LIMIT_EXCEEDED: No complete observation is available; use operator inventory.');
    if (this.storageAdapter) {
      // Refuse false emptiness if an in-memory active task has not reached durable storage.
      const persisted = new Map(source.map(task => [task.taskId, task]));
      for (const task of this.tasks.values()) {
        if (included(task) && persisted.get(task.taskId)?.status !== task.status) {
          throw new Error('INVENTORY_UNAVAILABLE: In-memory and durable task states differ.');
        }
      }
    }
    const rows = source.map(task => {
      if (!validId(task.taskId) || !['local', 'kaggle', 'browser', 'swarm'].includes(task.backend) ||
          !included(task) || (task.targetDeviceId !== undefined && !validId(task.targetDeviceId))) {
        throw new Error('INVENTORY_UNAVAILABLE: Unexpected stored task metadata.');
      }
      const priorClaimant = task.lease?.claimedBy || [...(task.attempts || [])].reverse().find(attempt => attempt.claimedBy)?.claimedBy;
      return {
        taskId: task.taskId, backend: task.backend, capability: validId(task.capability) ? task.capability : 'unknown',
        status: task.status, targetDeviceId: task.targetDeviceId || null, priorClaimant: validId(priorClaimant) ? priorClaimant : null,
        isQuarantined: task.backend === 'local' && !task.targetDeviceId && ACTIVE_TASK_STATUSES.has(task.status),
        attemptCount: (task.attempts || []).length, leaseExpiresAt: task.lease?.leaseExpiresAt ?? null,
        createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt ?? null, completedAt: task.completedAt ?? null
      };
    }).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
    const summary = {
      allActiveCount: rows.filter(task => ACTIVE_TASK_STATUSES.has(task.status)).length,
      activeLocalCount: rows.filter(task => task.backend === 'local' && ACTIVE_TASK_STATUSES.has(task.status)).length,
      quarantinedLocalCount: rows.filter(task => task.isQuarantined).length,
      staleLocalCount: rows.filter(task => task.backend === 'local' && task.status === 'stale').length
    };
    const snapshotRevision = crypto.createHash('sha256').update(JSON.stringify({ backend, status, targetDeviceId, rows })).digest('hex');
    if (args.snapshotRevision && args.snapshotRevision !== snapshotRevision) {
      throw new Error('INVENTORY_SNAPSHOT_CHANGED: Restart pagination at offset zero.');
    }
    const selected = rows.filter(task => (backend === 'all' || task.backend === backend) &&
      (targetDeviceId === undefined || task.targetDeviceId === targetDeviceId) &&
      (status === 'all' || (status === 'active' && ACTIVE_TASK_STATUSES.has(task.status)) ||
        (status === 'stale' && task.status === 'stale') || (status === 'quarantined' && task.isQuarantined)));
    if (offset > selected.length) throw new Error('INVALID_ARGUMENT: Inventory offset exceeds snapshot.');
    const hasMore = offset + limit < selected.length;
    return {
      ok: true, checkedAt: Date.now(), snapshotRevision, total: selected.length, offset, limit, hasMore,
      snapshotComplete: true, pageComplete: offset === 0 && !hasMore,
      coverage: 'ALL_ACTIVE_BACKENDS_AND_LOCAL_STALE', summary,
      observedEmpty: summary.allActiveCount === 0 && summary.staleLocalCount === 0,
      maintenanceAuthorized: false, tasks: selected.slice(offset, offset + limit)
    };
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
