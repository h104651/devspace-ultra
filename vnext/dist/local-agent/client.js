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
const task_executor_1 = require("./task-executor");
const environment_probe_1 = require("./environment-probe");
class LocalAgentClient {
    config;
    executor;
    ws;
    isRunning = false;
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
        this.executor = new task_executor_1.TaskExecutor({
            allowedWorkspaces: config.allowedWorkspaces,
            allowRawShell: config.allowRawShell
        });
    }
    start() {
        this.isRunning = true;
        this.connect();
    }
    stop() {
        this.isRunning = false;
        if (this.reconnectTimeout)
            clearTimeout(this.reconnectTimeout);
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
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
            this.send({
                type: 'TASK_FAIL',
                messageId: crypto.randomUUID(),
                timestamp: Date.now(),
                taskId: task.taskId,
                deviceId: this.config.deviceId,
                error: {
                    code: 'LOCAL_TASK_EXECUTION_ERROR',
                    message: err.message || 'Unknown execution error'
                }
            });
        }
        finally {
            this.activeTasks.delete(task.taskId);
        }
    }
}
exports.LocalAgentClient = LocalAgentClient;
