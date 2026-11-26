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
exports.LocalAgentClient = void 0;
const ws_1 = require("ws");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const task_executor_1 = require("./task-executor");
const environment_probe_1 = require("./environment-probe");
const capabilities_1 = require("./capabilities");
class LocalAgentClient {
    config;
    executor;
    executorConfig;
    executorConfigRevision;
    rejectedExecutorConfigRevision;
    ws;
    isRunning = false;
    isStopping = false;
    reconnectTimeout;
    heartbeatTimer;
    registrationTimer;
    pollTimer;
    activeTasks = new Map();
    reconnectAttempts = 0;
    reconnectProof = crypto.randomBytes(32).toString('hex');
    reconnectSequence = 0;
    legacyRetryAvailable = false;
    registeredSocket;
    registeredSessionId;
    executionPolicyFingerprint;
    executionPolicyRevision;
    taskSockets = new Map();
    lastPolicyError;
    policyRejectedNotified = false;
    constructor(config) {
        this.config = {
            ...config,
            heartbeatIntervalMs: config.heartbeatIntervalMs || 10000,
            pollIntervalMs: config.pollIntervalMs || 3000
        };
        this.executorConfig = {
            allowedWorkspaces: config.allowedWorkspaces,
            projects: config.projects,
            projectRegistry: config.projectRegistry,
            projectsConfigFile: config.projectsConfigFile,
            allowRawShell: config.allowRawShell,
            hostExecutionBlocked: config.hostExecutionBlocked,
            windowsJobRunnerPath: config.windowsJobRunnerPath
        };
        const revisionBeforeLoad = this.computeExecutorConfigRevision();
        this.executor = new task_executor_1.TaskExecutor(this.executorConfig);
        this.executorConfigRevision = this.computeExecutorConfigRevision();
        if (revisionBeforeLoad !== this.executorConfigRevision)
            this.executorConfigRevision = undefined;
    }
    hasInFlightTasks() {
        return this.activeTasks.size > 0;
    }
    getInFlightTasks() {
        return Array.from(this.activeTasks.values()).map((task) => ({
            taskId: task.taskId,
            capability: task.capability,
            isMutation: (0, capabilities_1.isSideEffectCapability)(task.capability)
        }));
    }
    notifyPolicyRejected(reason) {
        if (this.policyRejectedNotified)
            return;
        this.policyRejectedNotified = true;
        try {
            this.config.onPolicyRejected?.(reason);
        }
        catch { }
    }
    start() {
        if (this.isRunning || this.isStopping || this.activeTasks.size > 0)
            return;
        this.isRunning = true;
        this.connect();
    }
    async stop(options) {
        if (this.isStopping)
            return;
        this.isStopping = true;
        this.isRunning = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        if (this.registrationTimer) {
            clearTimeout(this.registrationTimer);
            this.registrationTimer = undefined;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        // Await bounded completion of in-flight active tasks if any
        const timeout = options?.timeoutMs ?? 2000;
        const start = Date.now();
        while (this.activeTasks.size > 0 && Date.now() - start < timeout) {
            await new Promise(res => setTimeout(res, 50));
        }
        // Keep leases alive while existing tasks drain; stop heartbeats only before closing.
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        // Orderly WebSocket close handshake
        if (this.ws) {
            const socket = this.ws;
            this.ws = undefined;
            this.registeredSocket = undefined;
            if (socket.readyState === ws_1.WebSocket.OPEN) {
                await new Promise((resolve) => {
                    const timer = setTimeout(() => {
                        try {
                            if (typeof socket.terminate === 'function')
                                socket.terminate();
                        }
                        catch { }
                        resolve();
                    }, Math.min(timeout, 1500));
                    socket.once('close', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                    try {
                        socket.close(1000, 'Agent shutting down gracefully');
                    }
                    catch {
                        clearTimeout(timer);
                        resolve();
                    }
                });
            }
        }
        this.isStopping = false;
    }
    /**
     * Returns a content revision for the only executor configuration source that
     * can legitimately change while this long-lived process is running.
     *
     * Explicit in-memory ProjectRegistry ownership is intentionally excluded: its
     * caller owns mutation/lifecycle and replacing it behind that caller's back
     * would violate the object boundary.
     */
    computeExecutorConfigRevision() {
        if (this.executorConfig.projectRegistry || !this.executorConfig.projectsConfigFile) {
            return undefined;
        }
        try {
            const raw = fs.readFileSync(this.executorConfig.projectsConfigFile);
            return crypto.createHash('sha256').update(raw).digest('hex');
        }
        catch {
            // Missing/unreadable transient writes keep the last good executor. The
            // next readable file will produce a revision and be considered normally.
            return undefined;
        }
    }
    /**
     * Hot-refresh the project-backed TaskExecutor only at an idle boundary.
     *
     * This is the vNext equivalent of upstream daemon config-revision handling:
     * changed configuration becomes live without a process restart, but active
     * work is never interrupted. Invalid/partial writes fail open to the last
     * known-good executor and the same rejected bytes are not retried every poll.
     */
    refreshExecutorConfigIfIdle() {
        if (this.activeTasks.size > 0)
            return false;
        const nextRevision = this.computeExecutorConfigRevision();
        if (!nextRevision || nextRevision === this.executorConfigRevision || nextRevision === this.rejectedExecutorConfigRevision) {
            return false;
        }
        try {
            const nextExecutor = new task_executor_1.TaskExecutor(this.executorConfig);
            if (this.computeExecutorConfigRevision() !== nextRevision)
                return false;
            this.executor = nextExecutor;
            this.executorConfigRevision = nextRevision;
            this.rejectedExecutorConfigRevision = undefined;
            console.log('[AGENT] Reloaded changed local project configuration without restarting the agent.');
            return true;
        }
        catch (err) {
            this.rejectedExecutorConfigRevision = nextRevision;
            console.warn(`[AGENT] Ignoring invalid changed project configuration; keeping last good executor: ${err?.message || err}`);
            return false;
        }
    }
    currentExecutionCapabilities(capabilities) {
        const executionPolicyReadable = !this.executorConfig.projectsConfigFile || !!this.executorConfig.projectRegistry ||
            (!!this.executorConfigRevision && this.computeExecutorConfigRevision() === this.executorConfigRevision);
        const projects = executionPolicyReadable && !this.executor.isHostExecutionBlocked() ? this.executor.getRegistry().listProjects().filter(p => p.enabled) : [];
        return capabilities.filter(cap => {
            if (cap !== 'local:run_tests' && cap !== 'local:build_project')
                return true;
            return projects.some(project => project.availableCapabilities.includes(cap));
        });
    }
    // Keep the fingerprint local: configured arguments/env must never be exposed
    // via the wire. A fresh opaque generation is advertised per registration.
    computeExecutionPolicyFingerprint() {
        try {
            if (this.executor.isHostExecutionBlocked())
                return undefined;
            if (!this.currentExecutionCapabilities(['local:run_tests', 'local:build_project']).length)
                return undefined;
            const registry = this.executor.getRegistry();
            const projects = registry.listProjects().filter(p => p.enabled)
                .map(p => registry.getProject(p.projectId));
            return crypto.createHash('sha256').update(JSON.stringify({
                sourceRevision: this.executorConfigRevision,
                projects
            })).digest('hex');
        }
        catch {
            return undefined;
        }
    }
    currentExecutionPolicyRevision() {
        if (this.executionPolicyRevision && this.computeExecutionPolicyFingerprint() !== this.executionPolicyFingerprint) {
            // Revocation is sticky within a session, even if the old config is restored.
            this.executionPolicyRevision = undefined;
        }
        return this.executionPolicyRevision;
    }
    connect() {
        if (!this.isRunning)
            return;
        const probe = environment_probe_1.EnvironmentProbe.probe({ allowRawShell: this.config.allowRawShell });
        const WSClass = ws_1.WebSocket.WebSocket || ws_1.WebSocket;
        const socket = new WSClass(this.config.gatewayUrl);
        this.ws = socket;
        socket.on('open', () => {
            if (this.ws !== socket || !this.isRunning) {
                socket.close();
                return;
            }
            this.lastPolicyError = undefined;
            this.refreshExecutorConfigIfIdle();
            this.registerWithGateway(probe);
            this.registrationTimer = setTimeout(() => {
                if (this.ws === socket && this.registeredSocket !== socket && this.isRunning)
                    socket.terminate();
            }, 15_000);
            this.startHeartbeat();
            this.startPollLoop(probe.capabilities);
        });
        socket.on('message', (data) => {
            if (this.ws !== socket)
                return;
            try {
                const msg = JSON.parse(data.toString('utf-8'));
                this.handleGatewayMessage(msg, socket);
            }
            catch (err) {
                console.error('[AGENT] Failed to parse message from gateway:', err);
            }
        });
        socket.on('close', (code, reason) => {
            if (this.ws !== socket)
                return;
            const wasRegistered = this.registeredSocket === socket;
            this.ws = undefined;
            this.registeredSocket = undefined;
            if (this.registrationTimer)
                clearTimeout(this.registrationTimer);
            this.registrationTimer = undefined;
            if (this.heartbeatTimer)
                clearInterval(this.heartbeatTimer);
            if (this.pollTimer)
                clearInterval(this.pollTimer);
            const closeReason = reason?.toString() || '';
            if (wasRegistered && code === 1006)
                this.legacyRetryAvailable = true;
            // Compatibility with an old gateway only: wait out its heartbeat TTL once.
            if (this.isRunning && !this.lastPolicyError && code === 1008 && closeReason === 'Duplicate active device session' && this.legacyRetryAvailable) {
                this.legacyRetryAvailable = false;
                this.scheduleReconnect(46_000);
                return;
            }
            const policyReason = (code === 1008 && /duplicate|superseded|fenced|already registered|revoked|invalid reconnect identity|stale reconnect sequence|authentication failed/i.test(closeReason))
                ? closeReason
                : this.lastPolicyError;
            // Policy rejection is not a transient transport failure. Require operator
            // action rather than allowing two processes to continuously evict each other.
            if (policyReason) {
                this.isRunning = false;
                console.warn(`[AGENT] Session rejected by gateway (${policyReason}); restart manually after resolving duplicate or revoked identity.`);
                this.notifyPolicyRejected(policyReason);
                return;
            }
            if (this.isRunning)
                this.scheduleReconnect();
        });
        socket.on('error', (err) => {
            // Handled by close event
        });
    }
    scheduleReconnect(minDelayMs = 0) {
        this.reconnectAttempts++;
        const delay = Math.max(minDelayMs, Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000));
        this.reconnectTimeout = setTimeout(() => {
            if (this.activeTasks.size > 0) {
                // Old executors must finish before this process can obtain new work.
                if (this.isRunning)
                    this.scheduleReconnect();
                return;
            }
            this.connect();
        }, delay);
    }
    send(msg, socket = this.ws) {
        if (socket && socket === this.ws && socket.readyState === ws_1.WebSocket.OPEN) {
            socket.send(JSON.stringify(msg));
        }
    }
    registerWithGateway(probe) {
        this.registeredSessionId = undefined;
        this.executionPolicyFingerprint = this.computeExecutionPolicyFingerprint();
        this.executionPolicyRevision = this.executionPolicyFingerprint ? crypto.randomBytes(16).toString('hex') : undefined;
        this.send({
            type: 'AGENT_REGISTER',
            messageId: crypto.randomUUID(),
            timestamp: Date.now(),
            deviceId: this.config.deviceId,
            name: this.config.name || `Local-Agent-${probe.hostname}`,
            platform: probe.platform,
            capabilities: this.currentExecutionCapabilities(probe.capabilities),
            executionPolicyRevision: this.executionPolicyRevision,
            token: this.config.token,
            supportsAttemptFencing: true,
            reconnectProof: this.reconnectProof,
            reconnectSequence: ++this.reconnectSequence
        });
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            if (this.registeredSocket !== this.ws)
                return;
            this.send({
                type: 'AGENT_HEARTBEAT',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                deviceId: this.config.deviceId,
                activeTaskIds: Array.from(this.activeTasks.keys()).filter(id => this.taskSockets.get(id) === this.ws),
                activeTaskAttempts: Array.from(this.activeTasks.values())
                    .filter(task => this.taskSockets.get(task.taskId) === this.ws && !!task.activeAttemptId)
                    .map(task => ({ taskId: task.taskId, attemptId: task.activeAttemptId }))
            });
        }, this.config.heartbeatIntervalMs);
    }
    startPollLoop(capabilities) {
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => {
            if (!this.isRunning || this.isStopping || this.registeredSocket !== this.ws || this.activeTasks.size > 0)
                return;
            this.refreshExecutorConfigIfIdle();
            this.send({
                type: 'TASK_CLAIM_POLL',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                deviceId: this.config.deviceId,
                supportedCapabilities: this.currentExecutionCapabilities(capabilities),
                executionPolicyRevision: this.currentExecutionPolicyRevision()
            });
        }, this.config.pollIntervalMs);
    }
    handleGatewayMessage(msg, socket = this.ws) {
        if (!socket || socket !== this.ws)
            return;
        if (msg.type === 'ERROR') {
            const errText = typeof msg.error === 'string' ? msg.error : '';
            if (/^(AUTH_FAILED|DEVICE_REVOKED|TOKEN_SUPERSEDED|SESSION_FENCED)\b/i.test(errText)) {
                this.lastPolicyError = errText;
                this.isRunning = false;
            }
            return;
        }
        if (msg.type === 'AGENT_REGISTERED') {
            if (msg.deviceId === this.config.deviceId) {
                this.registeredSocket = socket;
                this.registeredSessionId = msg.sessionId;
                if (this.registrationTimer)
                    clearTimeout(this.registrationTimer);
                this.registrationTimer = undefined;
                this.reconnectAttempts = 0;
                this.legacyRetryAvailable = false;
            }
            return;
        }
        if (msg.type === 'TASK_ASSIGNED') {
            if (!this.isRunning || this.isStopping || this.registeredSocket !== socket || this.activeTasks.size > 0)
                return;
            const task = msg.task;
            if (task.targetDeviceId && task.targetDeviceId !== this.config.deviceId) {
                console.warn(`[AGENT] Task '${task.taskId}' was targeted to '${task.targetDeviceId}', but this agent is '${this.config.deviceId}'. Ignoring misrouted task.`);
                return;
            }
            this.activeTasks.set(task.taskId, task);
            this.taskSockets.set(task.taskId, socket);
            // Send ACK
            this.send({
                type: 'TASK_ACK',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                taskId: task.taskId,
                deviceId: this.config.deviceId,
                attemptId: task.activeAttemptId
            }, socket);
            // Execute asynchronously with the immutable originating socket.
            this.runAssignedTask(task, socket);
        }
    }
    async runAssignedTask(task, socket = this.taskSockets.get(task.taskId)) {
        let retainTaskForAudit = false;
        const sendForAttempt = (message) => {
            if (!socket || this.activeTasks.get(task.taskId) !== task || this.taskSockets.get(task.taskId) !== socket)
                return;
            this.send({ ...message, attemptId: task.activeAttemptId }, socket);
        };
        try {
            sendForAttempt({
                type: 'TASK_PROGRESS',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                taskId: task.taskId,
                deviceId: this.config.deviceId,
                stage: 'RUNNING'
            });
            const logBuffer = [];
            const flushLogs = () => {
                if (logBuffer.length > 0) {
                    const chunk = logBuffer.splice(0, logBuffer.length);
                    sendForAttempt({
                        type: 'TASK_LOG_APPEND',
                        messageId: crypto.randomUUID(),
                        timestamp: Date.now(),
                        taskId: task.taskId,
                        deviceId: this.config.deviceId,
                        lines: chunk
                    });
                }
            };
            if (task.capability === 'local:run_tests' || task.capability === 'local:build_project') {
                // Policy may have changed since the claim poll. Never execute with stale config.
                const admission = task.metadata?.executionAdmission;
                const revision = this.currentExecutionPolicyRevision();
                if (!revision || !this.registeredSessionId || admission?.sessionId !== this.registeredSessionId ||
                    admission?.policyRevision !== revision || !this.currentExecutionCapabilities([task.capability]).includes(task.capability)) {
                    throw new Error('EXECUTION_POLICY_CHANGED: Local execution policy is unavailable or no longer permits this capability.');
                }
            }
            const result = await this.executor.executeTask(task, (line) => {
                logBuffer.push(line);
                if (logBuffer.length >= 5) {
                    flushLogs();
                }
            });
            flushLogs();
            sendForAttempt({
                type: 'TASK_COMPLETE',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                taskId: task.taskId,
                deviceId: this.config.deviceId,
                result
            });
        }
        catch (err) {
            const errCode = err.code || (typeof err.message === 'string' && err.message.split(':')[0]) || 'LOCAL_TASK_EXECUTION_ERROR';
            if (errCode === 'LOCAL_PROCESS_TREE_UNCERTAIN' && (0, capabilities_1.isSideEffectCapability)(task.capability)) {
                // Leave the attempt in flight for lease-expiry recovery. Never advertise
                // normal failure/completion or release the local agent lock.
                retainTaskForAudit = true;
                this.isRunning = false;
                if (this.reconnectTimeout)
                    clearTimeout(this.reconnectTimeout);
                if (this.registrationTimer)
                    clearTimeout(this.registrationTimer);
                if (this.pollTimer)
                    clearInterval(this.pollTimer);
                if (this.heartbeatTimer)
                    clearInterval(this.heartbeatTimer);
                this.registeredSocket = undefined;
                try {
                    this.ws?.terminate();
                }
                catch { }
                this.notifyPolicyRejected('LOCAL_PROCESS_TREE_UNCERTAIN: Manual task and process-tree reconciliation required.');
                return;
            }
            sendForAttempt({
                type: 'TASK_FAIL',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                taskId: task.taskId,
                deviceId: this.config.deviceId,
                retryable: false,
                error: {
                    code: errCode,
                    message: err.message || 'Unknown execution error'
                }
            });
        }
        finally {
            if (!retainTaskForAudit && this.activeTasks.get(task.taskId) === task) {
                this.activeTasks.delete(task.taskId);
                this.taskSockets.delete(task.taskId);
            }
            this.refreshExecutorConfigIfIdle();
        }
    }
}
exports.LocalAgentClient = LocalAgentClient;
