import * as crypto from 'crypto';
import { WebSocket } from 'ws';
import { AuthManager } from '../security/auth-manager';
import { KillSwitch } from '../security/kill-switch';
import { AuditLogger } from '../security/audit-logger';
import { ScopeChecker } from '../security/scope-checker';
import { isLocalExecutableCapability, LOCAL_EXECUTABLE_CAPABILITIES } from '../local-agent/capabilities';
import { TaskStore } from '../storage/task-store';
import { GatewayMessage } from '../types/gateway';
import { isSessionHealthy } from './connection-health-policy';

export interface ConnectedAgent {
  sessionId: string;
  supportsAttemptFencing?: boolean;
  deviceId: string;
  name: string;
  platform: string;
  capabilities: string[];
  socket: WebSocket;
  connectedAt: number;
  lastHeartbeatAt: number;
  ip?: string;
}

export class ConnectionManager {
  private agents: Map<string, ConnectedAgent> = new Map();
  private sockets: Map<WebSocket, ConnectedAgent> = new Map();
  private authManager: AuthManager;
  private killSwitch: KillSwitch;
  private auditLogger: AuditLogger;
  private taskStore: TaskStore;

  constructor(
    authManager: AuthManager,
    killSwitch: KillSwitch,
    auditLogger: AuditLogger,
    taskStore: TaskStore
  ) {
    this.authManager = authManager;
    this.killSwitch = killSwitch;
    this.auditLogger = auditLogger;
    this.taskStore = taskStore;
  }

  public handleConnection(socket: WebSocket, ip?: string): void {
    let authenticatedDeviceId: string | undefined;

    socket.on('message', (data: Buffer | string) => {
      try {
        const raw = data.toString('utf-8');
        const msg: GatewayMessage = JSON.parse(raw);
        this.processMessage(socket, msg, authenticatedDeviceId, (devId) => {
          authenticatedDeviceId = devId;
        }, ip);
      } catch (err: any) {
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
          } else {
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

  private processMessage(
    socket: WebSocket,
    msg: GatewayMessage,
    authenticatedDeviceId: string | undefined,
    setDeviceId: (id: string) => void,
    ip?: string
  ) {
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
        : [...LOCAL_EXECUTABLE_CAPABILITIES];

      const authorizedCaps = requestedCaps.filter(cap => {
        if (!isLocalExecutableCapability(cap)) return false;
        const requiredScope = ScopeChecker.getRequiredScopeForCapability(cap);
        return ScopeChecker.hasScope(auth.payload!.scopes, requiredScope);
      });

      // Evict any prior connection for this device ID to maintain single active session
      const oldAgent = this.agents.get(authoritativeDeviceId);
      if (oldAgent && oldAgent.socket !== socket && isSessionHealthy(oldAgent) && oldAgent.socket.readyState === WebSocket.OPEN) {
        socket.close(1008, 'Duplicate active device session');
        return;
      }
      if (oldAgent && oldAgent.socket !== socket) {
        try {
          oldAgent.socket.close(1008, 'Superseded by new registration');
        } catch {}
        this.sockets.delete(oldAgent.socket);
        this.taskStore.failTasksForSupersededSession(authoritativeDeviceId, oldAgent.sessionId, 'New registration superseded session');
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
      const agent: ConnectedAgent = {
        sessionId,
        supportsAttemptFencing: msg.supportsAttemptFencing === true,
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
      this.authManager.rememberAuthenticatedDevice(msg.token, authoritativeDeviceId, msg.name || authoritativeDeviceId, authorizedCaps, (msg.platform as any) || 'windows');
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
        messageId: (msg as any).messageId,
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
    if (!isSessionHealthy(agent)) {
      socket.close(1008, 'Heartbeat timeout');
      return;
    }
    const sessionId = agent.sessionId;
    const supportsAttemptFencing = agent.supportsAttemptFencing === true;
    const ownsAttempt = (taskId: string, attemptId?: string) => this.taskStore.ownsLocalAttempt(taskId, authenticatedDeviceId, sessionId, attemptId, supportsAttemptFencing);

    if (this.killSwitch.isDeviceRevoked(authenticatedDeviceId) || this.authManager.getDevice(authenticatedDeviceId)?.status === 'revoked') {
      socket.send(JSON.stringify({
        type: 'ERROR',
        messageId: (msg as any).messageId,
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
      const task = this.taskStore.claimTask(authenticatedDeviceId, agent.capabilities, undefined, sessionId, supportsAttemptFencing);
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

  public getConnectedAgents(options?: { healthyOnly?: boolean }): ConnectedAgent[] {
    const all = Array.from(this.sockets.values());
    if (!options?.healthyOnly) return all;
    const now = Date.now();
    return all.filter(a => this.agents.get(a.deviceId)?.sessionId === a.sessionId && a.socket.readyState === WebSocket.OPEN && !this.killSwitch.isDeviceRevoked(a.deviceId) && this.authManager.getDevice(a.deviceId)?.status !== 'revoked' && isSessionHealthy(a, now));
  }

  public getAgent(deviceId: string): ConnectedAgent | undefined {
    return this.agents.get(deviceId);
  }

  public disconnectDevice(deviceId: string, reason = 'Device revoked'): void {
    const agent = this.agents.get(deviceId);
    if (agent) {
      try {
        agent.socket.send(JSON.stringify({
          type: 'ERROR',
          timestamp: Date.now(),
          error: `DEVICE_REVOKED: ${reason}`
        }));
        agent.socket.close(1008, reason);
      } catch {}
      this.agents.delete(deviceId);
      this.sockets.delete(agent.socket);
    }
  }

  public sendToAgent(deviceId: string, message: any): boolean {
    const agent = this.agents.get(deviceId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    agent.socket.send(JSON.stringify(message));
    return true;
  }
}
