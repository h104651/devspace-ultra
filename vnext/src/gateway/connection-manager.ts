import { WebSocket } from 'ws';
import { AuthManager } from '../security/auth-manager';
import { KillSwitch } from '../security/kill-switch';
import { AuditLogger } from '../security/audit-logger';
import { ScopeChecker } from '../security/scope-checker';
import { isLocalExecutableCapability, LOCAL_EXECUTABLE_CAPABILITIES } from '../local-agent/capabilities';
import { TaskStore } from '../storage/task-store';
import { GatewayMessage } from '../types/gateway';

export interface ConnectedAgent {
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
      this.sockets.delete(socket);
      if (authenticatedDeviceId) {
        const remaining = Array.from(this.sockets.values()).filter(a => a.deviceId === authenticatedDeviceId);
        if (remaining.length === 0) {
          this.agents.delete(authenticatedDeviceId);
          this.authManager.updateDeviceStatus(authenticatedDeviceId, 'offline');
        } else {
          this.agents.set(authenticatedDeviceId, remaining[remaining.length - 1]);
        }
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

  private processMessage(
    socket: WebSocket,
    msg: GatewayMessage,
    authenticatedDeviceId: string | undefined,
    setDeviceId: (id: string) => void,
    ip?: string
  ) {
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
        : [...LOCAL_EXECUTABLE_CAPABILITIES];

      const authorizedCaps = requestedCaps.filter(cap => {
        if (!isLocalExecutableCapability(cap)) return false;
        const requiredScope = ScopeChecker.getRequiredScopeForCapability(cap);
        return ScopeChecker.hasScope(auth.payload!.scopes, requiredScope);
      });

      setDeviceId(authoritativeDeviceId);
      const agent: ConnectedAgent = {
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
        messageId: (msg as any).messageId,
        timestamp: Date.now(),
        error: 'AUTH_REQUIRED: Must authenticate with AGENT_REGISTER first'
      }));
      socket.close();
      return;
    }

    const agent = this.agents.get(authenticatedDeviceId);
    if (!agent) return;

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
      this.taskStore.failTask(msg.taskId, msg.error, { retryable: msg.retryable ?? false });
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

  public getConnectedAgents(): ConnectedAgent[] {
    return Array.from(this.sockets.values());
  }

  public getAgent(deviceId: string): ConnectedAgent | undefined {
    return this.agents.get(deviceId);
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
