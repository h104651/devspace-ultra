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
    pollTimer;
    activeTasks = new Map();
    reconnectAttempts = 0;
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
            allowRawShell: config.allowRawShell
        };
        this.executor = new task_executor_1.TaskExecutor(this.executorConfig);
        this.executorConfigRevision = this.computeExecutorConfigRevision();
    }
    start() {
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
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
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
        // Orderly WebSocket close handshake
        if (this.ws) {
            const socket = this.ws;
            this.ws = undefined;
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
    connect() {
        if (!this.isRunning)
            return;
        const probe = environment_probe_1.EnvironmentProbe.probe({ allowRawShell: this.config.allowRawShell });
        const WSClass = ws_1.WebSocket.WebSocket || ws_1.WebSocket;
        this.ws = new WSClass(this.config.gatewayUrl);
        this.ws.on('open', () => {
            this.reconnectAttempts = 0;
            this.refreshExecutorConfigIfIdle();
            this.registerWithGateway(probe);
            this.startHeartbeat();
            this.startPollLoop(probe.capabilities);
        });
        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString('utf-8'));
                this.handleGatewayMessage(msg);
            }
            catch (err) {
                console.error('[AGENT] Failed to parse message from gateway:', err);
            }
        });
        this.ws.on('close', () => {
            if (this.heartbeatTimer)
                clearInterval(this.heartbeatTimer);
            if (this.pollTimer)
                clearInterval(this.pollTimer);
            if (this.isRunning) {
                this.scheduleReconnect();
            }
        });
        this.ws.on('error', (err) => {
            // Handled by close event
        });
    }
    scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, delay);
    }
    send(msg) {
        if (this.ws && this.ws.readyState === ws_1.WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    registerWithGateway(probe) {
        this.send({
            type: 'AGENT_REGISTER',
            messageId: crypto.randomUUID(),
            timestamp: Date.now(),
            deviceId: this.config.deviceId,
            name: this.config.name || `Local-Agent-${probe.hostname}`,
            platform: probe.platform,
            capabilities: probe.capabilities,
            token: this.config.token
        });
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
            this.send({
                type: 'AGENT_HEARTBEAT',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                deviceId: this.config.deviceId,
                activeTaskIds: Array.from(this.activeTasks.keys())
            });
        }, this.config.heartbeatIntervalMs);
    }
    startPollLoop(capabilities) {
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => {
            this.refreshExecutorConfigIfIdle();
            this.send({
                type: 'TASK_CLAIM_POLL',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                deviceId: this.config.deviceId,
                supportedCapabilities: capabilities
            });
        }, this.config.pollIntervalMs);
    }
    handleGatewayMessage(msg) {
        if (msg.type === 'TASK_ASSIGNED') {
            const task = msg.task;
            if (task.targetDeviceId && task.targetDeviceId !== this.config.deviceId) {
                console.warn(`[AGENT] Task '${task.taskId}' was targeted to '${task.targetDeviceId}', but this agent is '${this.config.deviceId}'. Ignoring misrouted task.`);
                return;
            }
            this.activeTasks.set(task.taskId, task);
            // Send ACK
            this.send({
                type: 'TASK_ACK',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                taskId: task.taskId,
                deviceId: this.config.deviceId
            });
            // Execute asynchronously
            this.runAssignedTask(task);
        }
    }
    async runAssignedTask(task) {
        try {
            this.send({
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
                    this.send({
                        type: 'TASK_LOG_APPEND',
                        messageId: crypto.randomUUID(),
                        timestamp: Date.now(),
                        taskId: task.taskId,
                        deviceId: this.config.deviceId,
                        lines: chunk
                    });
                }
            };
            const result = await this.executor.executeTask(task, (line) => {
                logBuffer.push(line);
                if (logBuffer.length >= 5) {
                    flushLogs();
                }
            });
            flushLogs();
            this.send({
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
            this.send({
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
            this.activeTasks.delete(task.taskId);
            this.refreshExecutorConfigIfIdle();
        }
    }
}
exports.LocalAgentClient = LocalAgentClient;
