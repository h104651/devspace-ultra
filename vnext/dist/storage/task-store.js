"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const task_1 = require("../types/task");
const scope_checker_1 = require("../security/scope-checker");
const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'acknowledged', 'running']);
const TASK_LOG_MAX_LINES = 2000;
const TASK_LOG_MAX_ENTRY_BYTES = 4096;
const TASK_LOG_RETENTION_MARKER = `[LOG_RETENTION] Older task logs truncated; retaining newest ${TASK_LOG_MAX_LINES - 1} entries`;
const TASK_LOG_LINE_TRUNCATION_MARKER = ' …[LOG_LINE_TRUNCATED]';
class TaskStore {
    tasksDir;
    tasks = new Map();
    defaultLeaseDurationMs;
    storageAdapter;
    taskWaiters = new Map();
    constructor(storageDir, defaultLeaseDurationMs = 60000, storageAdapter) {
        this.defaultLeaseDurationMs = defaultLeaseDurationMs;
        this.storageAdapter = storageAdapter;
        if (storageDir && storageDir !== ':memory:') {
            this.tasksDir = path.join(storageDir, 'tasks');
            try {
                if (!fs.existsSync(this.tasksDir)) {
                    fs.mkdirSync(this.tasksDir, { recursive: true });
                }
                this.loadAll();
            }
            catch { }
        }
    }
    hydrate(tasks) {
        for (const task of tasks || []) {
            if (task?.taskId) {
                this.normalizeAttemptLedger(task);
                this.normalizeLogEntries(task);
                this.tasks.set(task.taskId, task);
            }
        }
    }
    loadAll() {
        if (!this.tasksDir)
            return;
        try {
            const files = fs.readdirSync(this.tasksDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const raw = fs.readFileSync(path.join(this.tasksDir, file), 'utf-8');
                        const task = JSON.parse(raw);
                        this.normalizeAttemptLedger(task);
                        this.normalizeLogEntries(task);
                        this.tasks.set(task.taskId, task);
                    }
                    catch (err) {
                        console.error(`Failed to load task file ${file}:`, err);
                    }
                }
            }
        }
        catch (err) {
            console.error('Failed to read tasks directory:', err);
        }
    }
    normalizeAttemptLedger(task) {
        if (!Array.isArray(task.attempts))
            task.attempts = [];
        if (task.activeAttemptId && !task.attempts.some(attempt => attempt.id === task.activeAttemptId)) {
            // A dangling pointer from an interrupted/partial older write is never
            // treated as proof that work is active. Task/lease state remains the
            // authority and the next valid transition can create a replacement record.
            task.activeAttemptId = undefined;
        }
    }
    truncateLogEntry(value) {
        const text = String(value ?? '');
        if (Buffer.byteLength(text, 'utf8') <= TASK_LOG_MAX_ENTRY_BYTES)
            return text;
        const suffixBytes = Buffer.byteLength(TASK_LOG_LINE_TRUNCATION_MARKER, 'utf8');
        const maxPrefixBytes = Math.max(0, TASK_LOG_MAX_ENTRY_BYTES - suffixBytes);
        const prefixChars = [];
        let prefixBytes = 0;
        for (const char of text) {
            const charBytes = Buffer.byteLength(char, 'utf8');
            if (prefixBytes + charBytes > maxPrefixBytes)
                break;
            prefixChars.push(char);
            prefixBytes += charBytes;
        }
        return `${prefixChars.join('')}${TASK_LOG_LINE_TRUNCATION_MARKER}`;
    }
    normalizeLogEntries(task) {
        if (!Array.isArray(task.logs))
            task.logs = [];
        task.logs = task.logs.map(line => this.truncateLogEntry(line));
        this.enforceLogRetention(task);
    }
    enforceLogRetention(task) {
        if (!Array.isArray(task.logs))
            task.logs = [];
        if (task.logs.length <= TASK_LOG_MAX_LINES)
            return;
        const newest = task.logs.slice(-(TASK_LOG_MAX_LINES - 1));
        task.logs = [TASK_LOG_RETENTION_MARKER, ...newest];
    }
    saveTask(task) {
        this.enforceLogRetention(task);
        task.updatedAt = Date.now();
        if (this.tasksDir) {
            try {
                if (!fs.existsSync(this.tasksDir)) {
                    fs.mkdirSync(this.tasksDir, { recursive: true });
                }
                const taskPath = path.join(this.tasksDir, `${task.taskId}.json`);
                fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
            }
            catch { }
        }
        if (this.storageAdapter) {
            void this.storageAdapter.saveTask(task).catch(err => {
                console.error(`Failed to persist task ${task.taskId} through storage adapter:`, err);
            });
        }
        this.notifyTaskChanged(task);
    }
    notifyTaskChanged(task) {
        const listeners = this.taskWaiters.get(task.taskId);
        if (!listeners || listeners.size === 0)
            return;
        for (const listener of Array.from(listeners))
            listener(task);
    }
    getActiveAttempt(task) {
        if (!task.activeAttemptId || !task.attempts)
            return undefined;
        return task.attempts.find(attempt => attempt.id === task.activeAttemptId);
    }
    createAttempt(task, deviceId, claimedAt = Date.now()) {
        this.normalizeAttemptLedger(task);
        const referenced = this.getActiveAttempt(task);
        if (referenced && ACTIVE_ATTEMPT_STATUSES.has(referenced.status))
            return undefined;
        if (referenced)
            task.activeAttemptId = undefined;
        const attempts = task.attempts;
        const attemptNumber = attempts.length + 1;
        const attempt = {
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
    ensureActiveAttempt(task, deviceId) {
        this.normalizeAttemptLedger(task);
        const current = this.getActiveAttempt(task);
        if (current)
            return current.claimedBy === deviceId ? current : undefined;
        if (!task.lease || task.lease.claimedBy !== deviceId)
            return undefined;
        const attempt = this.createAttempt(task, deviceId, task.lease.claimedAt);
        if (!attempt)
            return undefined;
        if (task.status === 'acknowledged') {
            attempt.status = 'acknowledged';
            attempt.acknowledgedAt = task.lease.acknowledgedAt;
        }
        else if (task.status === 'running') {
            attempt.status = 'running';
            attempt.acknowledgedAt = task.lease.acknowledgedAt;
            attempt.startedAt = task.startedAt;
        }
        return attempt;
    }
    finishActiveAttempt(task, status, error) {
        this.normalizeAttemptLedger(task);
        let attempt = this.getActiveAttempt(task);
        if (!attempt &&
            task.lease?.claimedBy &&
            (task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running')) {
            attempt = this.ensureActiveAttempt(task, task.lease.claimedBy);
        }
        if (!attempt) {
            task.activeAttemptId = undefined;
            return;
        }
        attempt.status = status;
        attempt.completedAt = Date.now();
        if (error?.code)
            attempt.errorCode = error.code;
        if (error?.message)
            attempt.errorMessage = error.message;
        task.activeAttemptId = undefined;
    }
    createTask(options) {
        const taskId = options.taskId || `task-${crypto.randomBytes(8).toString('hex')}`;
        const requiredScope = options.requiredScope || scope_checker_1.ScopeChecker.getRequiredScopeForCapability(options.capability);
        const task = {
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
            targetDeviceId: options.targetDeviceId ? options.targetDeviceId.trim() : undefined,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: options.metadata
        };
        this.tasks.set(taskId, task);
        this.saveTask(task);
        return task;
    }
    getTask(taskId) {
        const cached = this.tasks.get(taskId);
        if (cached)
            return cached;
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
    findByIdempotencyKey(key) {
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
    waitForTask(taskId, options) {
        const initial = this.getTask(taskId);
        if (!initial)
            return Promise.reject(new Error(`TASK_NOT_FOUND: ${taskId}`));
        if (task_1.TERMINAL_TASK_STATUSES.has(initial.status)) {
            return Promise.resolve({ task: initial, timedOut: false });
        }
        const timeoutMs = Math.max(0, options?.timeoutMs ?? 30000);
        return new Promise((resolve) => {
            let settled = false;
            let timer;
            const cleanup = () => {
                if (timer)
                    clearTimeout(timer);
                const listeners = this.taskWaiters.get(taskId);
                listeners?.delete(listener);
                if (listeners && listeners.size === 0)
                    this.taskWaiters.delete(taskId);
            };
            const finish = (task, timedOut) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve({ task, timedOut });
            };
            const listener = (task) => {
                if (task_1.TERMINAL_TASK_STATUSES.has(task.status))
                    finish(task, false);
            };
            let listeners = this.taskWaiters.get(taskId);
            if (!listeners) {
                listeners = new Set();
                this.taskWaiters.set(taskId, listeners);
            }
            listeners.add(listener);
            // Close the registration race: the task may have completed between the
            // initial snapshot and listener insertion.
            const refreshed = this.getTask(taskId);
            if (refreshed && task_1.TERMINAL_TASK_STATUSES.has(refreshed.status)) {
                finish(refreshed, false);
                return;
            }
            timer = setTimeout(() => {
                const current = this.getTask(taskId) || initial;
                finish(current, !task_1.TERMINAL_TASK_STATUSES.has(current.status));
            }, timeoutMs);
        });
    }
    claimTask(deviceId, supportedCapabilities, leaseDurationMs) {
        this.recoverStaleTasks();
        const eligibleTasks = Array.from(this.tasks.values())
            .filter(t => {
            if (t.status !== 'queued')
                return false;
            if (!supportedCapabilities.includes(t.capability))
                return false;
            if (t.backend === 'local') {
                if (!t.targetDeviceId || t.targetDeviceId !== deviceId)
                    return false;
            }
            return true;
        })
            .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
        if (eligibleTasks.length === 0)
            return undefined;
        return this.claimTaskById(eligibleTasks[0].taskId, deviceId, leaseDurationMs);
    }
    claimTaskById(taskId, deviceId, leaseDurationMs) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'queued')
            return undefined;
        if (task.backend === 'local' && (!task.targetDeviceId || task.targetDeviceId !== deviceId))
            return undefined;
        const now = Date.now();
        const attempt = this.createAttempt(task, deviceId, now);
        if (!attempt)
            return undefined;
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
    migrateLegacyUnassignedTasks(options) {
        let migrated = 0;
        let quarantined = 0;
        let failedAmbiguous = 0;
        let trustedLegacyDeviceId = undefined;
        if (options) {
            if (Array.isArray(options)) {
                // If an array was passed, do NOT assume knownDeviceIds[0] is the owner unless trusted
                // Only accept if exactly one device is passed and it was explicitly designated
            }
            else if (typeof options === 'object') {
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
                if (task_1.ACTIVE_TASK_STATUSES.has(task.status)) {
                    quarantined++;
                }
            }
        }
        return { migrated, quarantined, failedAmbiguous };
    }
    assignQuarantinedTasks(targetDeviceId, taskIds) {
        let assigned = 0;
        const assignedTaskIds = [];
        if (!taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
            return { assigned: 0, taskIds: [] };
        }
        const targetSet = new Set(taskIds);
        for (const task of this.tasks.values()) {
            // Must be local backend, unassigned, active (non-terminal), and explicitly in taskIds
            if (task.backend === 'local' && !task.targetDeviceId && task_1.ACTIVE_TASK_STATUSES.has(task.status)) {
                if (!targetSet.has(task.taskId)) {
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
    acknowledgeTask(taskId, deviceId) {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'claimed' || task.lease?.claimedBy !== deviceId) {
            return false;
        }
        const attempt = this.ensureActiveAttempt(task, deviceId);
        if (!attempt || attempt.claimedBy !== deviceId)
            return false;
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
    startTask(taskId, deviceId) {
        const task = this.tasks.get(taskId);
        if (!task)
            return false;
        const now = Date.now();
        if (task.lease) {
            // A claimed task has an authoritative owner. No caller — including an
            // internal backend — may take over that active attempt implicitly.
            if (task.lease.claimedBy !== deviceId)
                return false;
            if (task.status !== 'claimed' && task.status !== 'acknowledged' && task.status !== 'running')
                return false;
        }
        else {
            // Gateway-internal backends historically start immediately after durable
            // submission and therefore do not perform the local-agent claim handshake.
            // Preserve that path, but require local-device tasks to claim first.
            if (task.backend === 'local' || task.status !== 'queued')
                return false;
            const created = this.createAttempt(task, deviceId, now);
            if (!created)
                return false;
            task.lease = {
                claimedBy: deviceId,
                claimedAt: now,
                leaseExpiresAt: now + this.defaultLeaseDurationMs,
                lastHeartbeatAt: now
            };
        }
        const attempt = this.ensureActiveAttempt(task, deviceId);
        if (!attempt || attempt.claimedBy !== deviceId)
            return false;
        if (task.status !== 'running') {
            task.status = 'running';
            task.startedAt = task.startedAt ?? now;
            attempt.status = 'running';
            attempt.startedAt = attempt.startedAt ?? now;
        }
        else {
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
    renewLease(taskId, deviceId, extensionMs) {
        const task = this.tasks.get(taskId);
        if (!task || !task.lease || task.lease.claimedBy !== deviceId) {
            return false;
        }
        if (task.status !== 'claimed' && task.status !== 'acknowledged' && task.status !== 'running') {
            return false;
        }
        const attempt = this.ensureActiveAttempt(task, deviceId);
        if (!attempt || attempt.claimedBy !== deviceId)
            return false;
        const now = Date.now();
        task.lease.lastHeartbeatAt = now;
        task.lease.leaseExpiresAt = now + (extensionMs || this.defaultLeaseDurationMs);
        this.saveTask(task);
        return true;
    }
    appendLogs(taskId, lines) {
        const task = this.tasks.get(taskId);
        if (!task)
            return;
        for (const line of lines) {
            task.logs.push(this.truncateLogEntry(`[${new Date().toISOString()}] ${line}`));
        }
        this.saveTask(task);
    }
    addArtifact(taskId, artifact) {
        const task = this.tasks.get(taskId);
        if (!task)
            return;
        if (!task.artifacts.some(existing => existing.id === artifact.id)) {
            task.artifacts.push(artifact);
            this.saveTask(task);
        }
    }
    completeTask(taskId, result) {
        const task = this.tasks.get(taskId);
        if (!task || task_1.TERMINAL_TASK_STATUSES.has(task.status))
            return false;
        this.finishActiveAttempt(task, 'succeeded');
        task.status = 'succeeded';
        task.result = result;
        task.completedAt = Date.now();
        task.lease = undefined;
        this.saveTask(task);
        return true;
    }
    failTask(taskId, error, options) {
        const task = this.tasks.get(taskId);
        if (!task || task_1.TERMINAL_TASK_STATUSES.has(task.status))
            return false;
        this.finishActiveAttempt(task, 'failed', error);
        const isRetryable = options?.retryable !== false && task.retryPolicy.retryCount < task.retryPolicy.maxRetries;
        if (isRetryable) {
            task.retryPolicy.retryCount++;
            task.lease = undefined;
            task.completedAt = undefined;
            if (!task.metadata)
                task.metadata = {};
            task.metadata.lastRetryError = error;
            // File-backed local runtimes can honor the requested backoff timer. Durable
            // cloud runtimes requeue immediately so a process eviction cannot strand a
            // task in an in-memory "retrying" timer that will never fire.
            if (this.storageAdapter) {
                task.status = 'queued';
                task.logs.push(this.truncateLogEntry(`[RETRY] Requeued durably after failure (attempt ${task.retryPolicy.retryCount}/${task.retryPolicy.maxRetries}): ${error.message}`));
            }
            else {
                task.status = 'retrying';
                setTimeout(() => {
                    const t = this.tasks.get(taskId);
                    if (t && t.status === 'retrying') {
                        t.status = 'queued';
                        this.saveTask(t);
                    }
                }, task.retryPolicy.backoffMs * task.retryPolicy.retryCount);
            }
        }
        else {
            task.status = 'failed';
            task.error = error;
            task.completedAt = Date.now();
            task.lease = undefined;
        }
        this.saveTask(task);
        return true;
    }
    failTaskTerminal(taskId, error) {
        return this.failTask(taskId, error, { retryable: false });
    }
    cancelTask(taskId, reason = 'User requested cancellation') {
        const task = this.tasks.get(taskId);
        if (!task)
            return false;
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
    setExternalRun(taskId, externalRun) {
        const task = this.tasks.get(taskId);
        if (!task)
            return false;
        task.externalRun = externalRun;
        this.saveTask(task);
        return true;
    }
    updateTask(taskId, updates) {
        const task = this.tasks.get(taskId);
        if (!task)
            return false;
        Object.assign(task, updates);
        this.normalizeAttemptLedger(task);
        if (updates.logs !== undefined)
            this.normalizeLogEntries(task);
        this.saveTask(task);
        return true;
    }
    recoverStaleTasks() {
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
            if ((task.status === 'claimed' || task.status === 'acknowledged' || task.status === 'running') &&
                task.lease &&
                now > task.lease.leaseExpiresAt) {
                const claimedBy = task.lease.claimedBy;
                task.logs.push(this.truncateLogEntry(`[STALE_DETECTION] Lease expired at ${new Date(task.lease.leaseExpiresAt).toISOString()} for worker ${claimedBy}`));
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
                }
                else {
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
    listTasks(filter) {
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
exports.TaskStore = TaskStore;
