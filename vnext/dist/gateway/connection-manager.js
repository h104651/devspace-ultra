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
exports.ConnectionManager = void 0;
const crypto = __importStar(require("crypto"));
const ws_1 = require("ws");
const scope_checker_1 = require("../security/scope-checker");
const capabilities_1 = require("../local-agent/capabilities");
const connection_health_policy_1 = require("./connection-health-policy");
class ConnectionManager {
    agents = new Map();
    sockets = new Map();
    authManager;
    killSwitch;
    auditLogger;
    taskStore;
    constructor(authManager, killSwitch, auditLogger, taskStore) {
        this.authManager = authManager;
        this.killSwitch = killSwitch;
        this.auditLogger = auditLogger;
        this.taskStore = taskStore;
    }
    handleConnection(socket, ip) {
        let authenticatedDeviceId;
        socket.on('message', (data) => {
            try {
                const raw = data.toString('utf-8');
                const msg = JSON.parse(raw);
                this.processMessage(socket, msg, authenticatedDeviceId, (devId) => {
                    authenticatedDeviceId = devId;
                }, ip);
            }
            catch (err) {
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: 'err',
                    timestamp: Date.now(),
                    error: `INVALID_MESSAGE: ${err.message}`
                }));
            }
        });
        socket.on('close', () => {
            const closedAgent = this.sockets.get(socket);
            this.sockets.delete(socket);
            if (authenticatedDeviceId) {
                const active = this.agents.get(authenticatedDeviceId);
                // Fencing: Only update device offline status if the closing socket matches the active session
                if (closedAgent && active && active.sessionId === closedAgent.sessionId) {
                    const remaining = Array.from(this.sockets.values()).filter(a => a.deviceId === authenticatedDeviceId);
                    if (remaining.length === 0) {
                        this.agents.delete(authenticatedDeviceId);
                        if (this.authManager.getDevice(authenticatedDeviceId)?.status !== 'revoked' && !this.killSwitch.isDeviceRevoked(authenticatedDeviceId)) {
                            this.authManager.updateDeviceStatus(authenticatedDeviceId, 'offline');
                        }
                    }
                    else {
                        this.agents.set(authenticatedDeviceId, remaining[remaining.length - 1]);
                    }
                }
                this.auditLogger.log({
                    actor: authenticatedDeviceId,
                    actorType: 'device',
                    action: 'AGENT_DISCONNECT',
                    result: 'SUCCESS',
                    details: { sessionId: closedAgent?.sessionId },
                    ip
                });
            }
        });
    }
    processMessage(socket, msg, authenticatedDeviceId, setDeviceId, ip) {
        if (msg.type === 'AGENT_REGISTER') {
            if (authenticatedDeviceId || this.sockets.has(socket)) {
                socket.close(1008, 'Already registered');
                return;
            }
            const auth = this.authManager.validateToken(msg.token);
            if (!auth.valid || !auth.payload || auth.payload.type !== 'device') {
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: `AUTH_FAILED: Device token required (received ${auth.payload?.type || 'invalid'})`
                }));
                socket.close();
                return;
            }
            if (msg.deviceId && auth.payload.subjectId !== msg.deviceId) {
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: `AUTH_FAILED: deviceId mismatch (token subject: ${auth.payload.subjectId}, message deviceId: ${msg.deviceId})`
                }));
                socket.close();
                return;
            }
            const authoritativeDeviceId = auth.payload.subjectId;
            if (this.killSwitch.isDeviceRevoked(authoritativeDeviceId) || this.authManager.getDevice(authoritativeDeviceId)?.status === 'revoked') {
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: 'DEVICE_REVOKED: Device is revoked'
                }));
                socket.close();
                return;
            }
            const requestedCaps = (Array.isArray(msg.capabilities) && msg.capabilities.length > 0)
                ? msg.capabilities
                : [...capabilities_1.LOCAL_EXECUTABLE_CAPABILITIES];
            const executionPolicyRevision = typeof msg.executionPolicyRevision === 'string' && /^[a-f0-9]{32}$/.test(msg.executionPolicyRevision)
                ? msg.executionPolicyRevision : undefined;
            const authorizedCaps = requestedCaps.filter(cap => {
                if (!(0, capabilities_1.isLocalExecutableCapability)(cap))
                    return false;
                if ((cap === 'local:run_tests' || cap === 'local:build_project') && !executionPolicyRevision)
                    return false;
                const requiredScope = scope_checker_1.ScopeChecker.getRequiredScopeForCapability(cap);
                return scope_checker_1.ScopeChecker.hasScope(auth.payload.scopes, requiredScope);
            });
            // Evict any prior connection for this device ID to maintain single active session
            let reconnectIdentity;
            try {
                reconnectIdentity = (0, connection_health_policy_1.parseReconnectIdentity)(msg);
            }
            catch {
                socket.close(1008, 'Invalid reconnect identity');
                return;
            }
            const oldAgent = this.agents.get(authoritativeDeviceId);
            const resume = (0, connection_health_policy_1.canResumeSession)(oldAgent, reconnectIdentity);
            if ((0, connection_health_policy_1.isSameReconnectIdentity)(oldAgent, reconnectIdentity) && !resume) {
                socket.close(1008, 'Stale reconnect sequence');
                return;
            }
            if (oldAgent && oldAgent.socket !== socket && (0, connection_health_policy_1.isSessionHealthy)(oldAgent) && oldAgent.socket.readyState === ws_1.WebSocket.OPEN && !resume) {
                socket.close(1008, reconnectIdentity ? 'Duplicate active device instance' : 'Duplicate active device session');
                return;
            }
            if (oldAgent && oldAgent.socket !== socket) {
                this.agents.delete(authoritativeDeviceId);
                this.sockets.delete(oldAgent.socket);
                this.taskStore.failTasksForSupersededSession(authoritativeDeviceId, oldAgent.sessionId, 'New registration superseded session');
                try {
                    oldAgent.socket.close(1008, 'Superseded by new registration');
                }
                catch { }
                this.auditLogger.log({
                    actor: authoritativeDeviceId,
                    actorType: 'device',
                    action: 'AGENT_SESSION_SUPERSEDED',
                    result: 'SUCCESS',
                    details: { oldSessionId: oldAgent.sessionId, reason: 'Duplicate registration' },
                    ip
                });
            }
            const sessionId = crypto.randomUUID();
            setDeviceId(authoritativeDeviceId);
            const agent = {
                sessionId,
                supportsAttemptFencing: msg.supportsAttemptFencing === true,
                executionPolicyRevision,
                ...reconnectIdentity,
                deviceId: authoritativeDeviceId,
                name: msg.name || authoritativeDeviceId,
                platform: msg.platform || 'windows',
                capabilities: authorizedCaps,
                socket,
                connectedAt: Date.now(),
                lastHeartbeatAt: Date.now(),
                ip
            };
            this.agents.set(authoritativeDeviceId, agent);
            this.sockets.set(socket, agent);
            this.authManager.rememberAuthenticatedDevice(msg.token, authoritativeDeviceId, msg.name || authoritativeDeviceId, authorizedCaps, msg.platform || 'windows');
            this.authManager.updateDeviceStatus(authoritativeDeviceId, 'online', ip);
            // NOTE: Connecting does NOT grant ownership of unassigned legacy tasks.
            // Tasks without verifiable claimant remain safely quarantined in queued state.
            this.auditLogger.log({
                actor: authoritativeDeviceId,
                actorType: 'device',
                action: 'AGENT_AUTHENTICATE',
                result: 'SUCCESS',
                ip
            });
            socket.send(JSON.stringify({
                type: 'AGENT_REGISTERED',
                messageId: msg.messageId,
                timestamp: Date.now(),
                deviceId: authoritativeDeviceId,
                sessionId
            }));
            return;
        }
        if (!authenticatedDeviceId) {
            socket.send(JSON.stringify({
                type: 'ERROR',
                messageId: msg.messageId,
                timestamp: Date.now(),
                error: 'AUTH_REQUIRED: Must authenticate with AGENT_REGISTER first'
            }));
            socket.close();
            return;
        }
        const agent = this.sockets.get(socket);
        if (!agent || agent.deviceId !== authenticatedDeviceId || this.agents.get(authenticatedDeviceId)?.sessionId !== agent.sessionId) {
            socket.close(1008, 'Session fenced');
            return;
        }
        if (!(0, connection_health_policy_1.isSessionHealthy)(agent)) {
            socket.close(1008, 'Heartbeat timeout');
            return;
        }
        const sessionId = agent.sessionId;
        const supportsAttemptFencing = agent.supportsAttemptFencing === true;
        const ownsAttempt = (taskId, attemptId) => this.taskStore.ownsLocalAttempt(taskId, authenticatedDeviceId, sessionId, attemptId, supportsAttemptFencing);
        if (this.killSwitch.isDeviceRevoked(authenticatedDeviceId) || this.authManager.getDevice(authenticatedDeviceId)?.status === 'revoked') {
            socket.send(JSON.stringify({
                type: 'ERROR',
                messageId: msg.messageId,
                timestamp: Date.now(),
                error: 'DEVICE_REVOKED: Device is revoked'
            }));
            socket.close();
            this.agents.delete(authenticatedDeviceId);
            this.sockets.delete(socket);
            return;
        }
        if (msg.type === 'AGENT_HEARTBEAT') {
            agent.lastHeartbeatAt = Date.now();
            this.authManager.updateDeviceHeartbeat(authenticatedDeviceId);
            // Renew lease for all owned active tasks
            if (msg.activeTaskIds && Array.isArray(msg.activeTaskIds)) {
                for (const tid of msg.activeTaskIds) {
                    const attemptId = Array.isArray(msg.activeTaskAttempts) ? msg.activeTaskAttempts.find(a => a.taskId === tid)?.attemptId : undefined;
                    if (ownsAttempt(tid, attemptId)) {
                        this.taskStore.renewLease(tid, authenticatedDeviceId, undefined, sessionId);
                    }
                }
            }
            socket.send(JSON.stringify({
                type: 'AGENT_HEARTBEAT_ACK',
                messageId: msg.messageId,
                timestamp: Date.now()
            }));
            return;
        }
        if (msg.type === 'TASK_CLAIM_POLL') {
            // Use strictly the agent's authorized capabilities, ignoring unauthorized escalation
            // Execution capabilities must be both session-authorized and currently requested by the agent.
            if (agent.executionPolicyRevision && msg.executionPolicyRevision !== agent.executionPolicyRevision) {
                agent.executionPolicyRevision = undefined;
            }
            const claimCapabilities = agent.capabilities.filter(cap => {
                if (cap !== 'local:run_tests' && cap !== 'local:build_project')
                    return true;
                return !!agent.executionPolicyRevision && Array.isArray(msg.supportedCapabilities) && msg.supportedCapabilities.includes(cap);
            });
            const task = this.taskStore.claimTask(authenticatedDeviceId, claimCapabilities, undefined, sessionId, supportsAttemptFencing, agent.executionPolicyRevision);
            if (task) {
                socket.send(JSON.stringify({
                    type: 'TASK_ASSIGNED',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    task
                }));
            }
            return;
        }
        if (msg.type === 'TASK_ACK') {
            if (!ownsAttempt(msg.taskId, msg.attemptId)) {
                this.auditLogger.log({
                    actor: authenticatedDeviceId,
                    actorType: 'device',
                    action: 'TASK_ACK_REJECTED',
                    taskId: msg.taskId,
                    result: 'FAILURE',
                    details: { reason: 'Task lease not owned by authenticated device' }
                });
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: 'LEASE_VIOLATION: Task lease not owned by device'
                }));
                return;
            }
            this.taskStore.acknowledgeTask(msg.taskId, authenticatedDeviceId, sessionId);
            return;
        }
        if (msg.type === 'TASK_PROGRESS') {
            if (ownsAttempt(msg.taskId, msg.attemptId)) {
                this.taskStore.startTask(msg.taskId, authenticatedDeviceId, sessionId);
                this.taskStore.appendLogs(msg.taskId, [`[PROGRESS] ${msg.stage} ${msg.percent !== undefined ? msg.percent + '%' : ''}`]);
            }
            return;
        }
        if (msg.type === 'TASK_LOG_APPEND') {
            if (ownsAttempt(msg.taskId, msg.attemptId)) {
                this.taskStore.appendLogs(msg.taskId, msg.lines);
            }
            return;
        }
        if (msg.type === 'TASK_COMPLETE') {
            if (!ownsAttempt(msg.taskId, msg.attemptId)) {
                this.auditLogger.log({
                    actor: authenticatedDeviceId,
                    actorType: 'device',
                    action: 'TASK_COMPLETE_REJECTED',
                    taskId: msg.taskId,
                    result: 'FAILURE',
                    details: { reason: 'Task lease not owned by authenticated device' }
                });
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: 'LEASE_VIOLATION: Task lease not owned by device'
                }));
                return;
            }
            this.taskStore.completeTask(msg.taskId, msg.result, authenticatedDeviceId, sessionId);
            this.auditLogger.log({
                actor: authenticatedDeviceId,
                actorType: 'device',
                action: 'TASK_COMPLETE',
                taskId: msg.taskId,
                result: 'SUCCESS'
            });
            return;
        }
        if (msg.type === 'TASK_FAIL') {
            if (!ownsAttempt(msg.taskId, msg.attemptId)) {
                this.auditLogger.log({
                    actor: authenticatedDeviceId,
                    actorType: 'device',
                    action: 'TASK_FAIL_REJECTED',
                    taskId: msg.taskId,
                    result: 'FAILURE',
                    details: { reason: 'Task lease not owned by authenticated device' }
                });
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: 'LEASE_VIOLATION: Task lease not owned by device'
                }));
                return;
            }
            this.taskStore.failTask(msg.taskId, msg.error, { retryable: msg.retryable ?? false, deviceId: authenticatedDeviceId, sessionId });
            this.auditLogger.log({
                actor: authenticatedDeviceId,
                actorType: 'device',
                action: 'TASK_FAIL',
                taskId: msg.taskId,
                result: 'FAILURE',
                details: typeof msg.error === 'object' ? msg.error : { error: msg.error }
            });
            return;
        }
    }
    getConnectedAgents(options) {
        const all = Array.from(this.sockets.values());
        if (!options?.healthyOnly)
            return all;
        const now = Date.now();
        return all.filter(a => this.agents.get(a.deviceId)?.sessionId === a.sessionId && a.socket.readyState === ws_1.WebSocket.OPEN && !this.killSwitch.isDeviceRevoked(a.deviceId) && this.authManager.getDevice(a.deviceId)?.status !== 'revoked' && (0, connection_health_policy_1.isSessionHealthy)(a, now));
    }
    getAgent(deviceId) {
        return this.agents.get(deviceId);
    }
    disconnectDevice(deviceId, reason = 'Device revoked') {
        const agent = this.agents.get(deviceId);
        if (agent) {
            try {
                agent.socket.send(JSON.stringify({
                    type: 'ERROR',
                    timestamp: Date.now(),
                    error: `DEVICE_REVOKED: ${reason}`
                }));
                agent.socket.close(1008, reason);
            }
            catch { }
            this.agents.delete(deviceId);
            this.sockets.delete(agent.socket);
        }
    }
    sendToAgent(deviceId, message) {
        const agent = this.agents.get(deviceId);
        if (!agent || agent.socket.readyState !== ws_1.WebSocket.OPEN) {
            return false;
        }
        agent.socket.send(JSON.stringify(message));
        return true;
    }
}
exports.ConnectionManager = ConnectionManager;
