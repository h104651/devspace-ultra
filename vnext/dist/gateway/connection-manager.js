"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
const ws_1 = require("ws");
const scope_checker_1 = require("../security/scope-checker");
const capabilities_1 = require("../local-agent/capabilities");
class ConnectionManager {
    agents = new Map();
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
            if (authenticatedDeviceId) {
                this.agents.delete(authenticatedDeviceId);
                this.authManager.updateDeviceStatus(authenticatedDeviceId, 'offline');
                this.auditLogger.log({
                    actor: authenticatedDeviceId,
                    actorType: 'device',
                    action: 'AGENT_DISCONNECT',
                    result: 'SUCCESS',
                    ip
                });
            }
        });
    }
    processMessage(socket, msg, authenticatedDeviceId, setDeviceId, ip) {
        if (msg.type === 'AGENT_REGISTER') {
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
            if (this.killSwitch.isDeviceRevoked(authoritativeDeviceId)) {
                socket.send(JSON.stringify({
                    type: 'ERROR',
                    messageId: msg.messageId,
                    timestamp: Date.now(),
                    error: 'DEVICE_REVOKED: Device is revoked by Kill Switch'
                }));
                socket.close();
                return;
            }
            const requestedCaps = (Array.isArray(msg.capabilities) && msg.capabilities.length > 0)
                ? msg.capabilities
                : [...capabilities_1.LOCAL_EXECUTABLE_CAPABILITIES];
            const authorizedCaps = requestedCaps.filter(cap => {
                if (!(0, capabilities_1.isLocalExecutableCapability)(cap))
                    return false;
                const requiredScope = scope_checker_1.ScopeChecker.getRequiredScopeForCapability(cap);
                return scope_checker_1.ScopeChecker.hasScope(auth.payload.scopes, requiredScope);
            });
            setDeviceId(authoritativeDeviceId);
            const agent = {
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
            this.authManager.updateDeviceStatus(authoritativeDeviceId, 'online', ip);
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
                deviceId: authoritativeDeviceId
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
        const agent = this.agents.get(authenticatedDeviceId);
        if (!agent)
            return;
        if (msg.type === 'AGENT_HEARTBEAT') {
            agent.lastHeartbeatAt = Date.now();
            this.authManager.updateDeviceHeartbeat(authenticatedDeviceId);
            // Renew lease for all owned active tasks
            if (msg.activeTaskIds && Array.isArray(msg.activeTaskIds)) {
                for (const tid of msg.activeTaskIds) {
                    const task = this.taskStore.getTask(tid);
                    if (task && task.lease?.claimedBy === authenticatedDeviceId) {
                        this.taskStore.renewLease(tid, authenticatedDeviceId);
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
            const task = this.taskStore.claimTask(authenticatedDeviceId, agent.capabilities);
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
            const task = this.taskStore.getTask(msg.taskId);
            if (!task || task.lease?.claimedBy !== authenticatedDeviceId) {
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
            this.taskStore.acknowledgeTask(msg.taskId, authenticatedDeviceId);
            return;
        }
        if (msg.type === 'TASK_PROGRESS') {
            const task = this.taskStore.getTask(msg.taskId);
            if (task && task.lease?.claimedBy === authenticatedDeviceId) {
                this.taskStore.startTask(msg.taskId, authenticatedDeviceId);
                this.taskStore.appendLogs(msg.taskId, [`[PROGRESS] ${msg.stage} ${msg.percent !== undefined ? msg.percent + '%' : ''}`]);
            }
            return;
        }
        if (msg.type === 'TASK_LOG_APPEND') {
            const task = this.taskStore.getTask(msg.taskId);
            if (task && task.lease?.claimedBy === authenticatedDeviceId) {
                this.taskStore.appendLogs(msg.taskId, msg.lines);
            }
            return;
        }
        if (msg.type === 'TASK_COMPLETE') {
            const task = this.taskStore.getTask(msg.taskId);
            if (!task || task.lease?.claimedBy !== authenticatedDeviceId) {
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
            this.taskStore.completeTask(msg.taskId, msg.result);
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
            const task = this.taskStore.getTask(msg.taskId);
            if (!task || task.lease?.claimedBy !== authenticatedDeviceId) {
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
            this.taskStore.failTask(msg.taskId, msg.error);
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
    getConnectedAgents() {
        return Array.from(this.agents.values());
    }
    getAgent(deviceId) {
        return this.agents.get(deviceId);
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
