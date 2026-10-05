import { WebSocket } from 'ws';
import { AuthManager } from '../security/auth-manager';
import { KillSwitch } from '../security/kill-switch';
import { AuditLogger } from '../security/audit-logger';
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

  private processMessage(
    socket: WebSocket,
    msg: GatewayMessage,
    authenticatedDeviceId: string | undefined,
    setDeviceId: (id: string) => void,
    ip?: string
  ) {
    if (msg.type === 'AGENT_REGISTER') {
      const auth = this.authManager.validateToken(msg.token);
      if (!auth.valid || !auth.payload || auth.payload.type !== 'device' || auth.payload.subjectId !== msg.deviceId) {
        socket.send(JSON.stringify({
          type: 'ERROR',
          messageId: msg.messageId,
          timestamp: Date.now(),
          error: `AUTH_FAILED: ${auth.error || 'Invalid device token'}`
        }));
        socket.close();
        return;
      }

      if (this.killSwitch.isDeviceRevoked(msg.deviceId)) {
        socket.send(JSON.stringify({
          type: 'ERROR',
          messageId: msg.messageId,
          timestamp: Date.now(),
          error: 'DEVICE_REVOKED: Device is revoked by Kill Switch'
        }));
        socket.close();
        return;
      }

      setDeviceId(msg.deviceId);
      const agent: ConnectedAgent = {
        deviceId: msg.deviceId,
        name: msg.name,
        platform: msg.platform,
        capabilities: msg.capabilities || [],
        socket,
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        ip
      };

      this.agents.set(msg.deviceId, agent);
      this.authManager.updateDeviceStatus(msg.deviceId, 'online', ip);
      this.auditLogger.log({
        actor: msg.deviceId,
        actorType: 'device',
        action: 'AGENT_AUTHENTICATE',
        result: 'SUCCESS',
        ip
      });

      socket.send(JSON.stringify({
        type: 'AGENT_REGISTERED',
        messageId: msg.messageId,
        timestamp: Date.now(),
        deviceId: msg.deviceId
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

      // Renew lease for all reported active tasks
      if (msg.activeTaskIds && Array.isArray(msg.activeTaskIds)) {
        for (const tid of msg.activeTaskIds) {
          this.taskStore.renewLease(tid, authenticatedDeviceId);
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
      const task = this.taskStore.claimTask(authenticatedDeviceId, msg.supportedCapabilities);
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
      this.taskStore.acknowledgeTask(msg.taskId, authenticatedDeviceId);
      return;
    }

    if (msg.type === 'TASK_PROGRESS') {
      this.taskStore.startTask(msg.taskId, authenticatedDeviceId);
      this.taskStore.appendLogs(msg.taskId, [`[PROGRESS] ${msg.stage} ${msg.percent !== undefined ? msg.percent + '%' : ''}`]);
      return;
    }

    if (msg.type === 'TASK_LOG_APPEND') {
      this.taskStore.appendLogs(msg.taskId, msg.lines);
      return;
    }

    if (msg.type === 'TASK_COMPLETE') {
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
      this.taskStore.failTask(msg.taskId, msg.error);
      this.auditLogger.log({
        actor: authenticatedDeviceId,
        actorType: 'device',
        action: 'TASK_FAIL',
        taskId: msg.taskId,
        result: 'FAILURE',
        details: msg.error
      });
      return;
    }
  }

  public getConnectedAgents(): ConnectedAgent[] {
    return Array.from(this.agents.values());
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
