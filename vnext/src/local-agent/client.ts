import { WebSocket } from 'ws';
import * as crypto from 'crypto';
import { TaskExecutor, TaskExecutorConfig } from './task-executor';
import { EnvironmentProbe } from './environment-probe';
import { ProjectRegistry, LocalProjectDefinition } from './project-registry';
import { DurableTask } from '../types/task';
import { GatewayMessage } from '../types/gateway';

export interface LocalAgentClientConfig {
  gatewayUrl: string; // e.g. "ws://localhost:4000/ws/agent"
  deviceId: string;
  token: string;
  name?: string;
  allowedWorkspaces?: string[];
  projects?: (LocalProjectDefinition | string)[];
  projectRegistry?: ProjectRegistry;
  projectsConfigFile?: string;
  allowRawShell?: boolean;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}

export class LocalAgentClient {
  private config: LocalAgentClientConfig;
  private executor: TaskExecutor;
  private ws?: WebSocket;
  private isRunning = false;
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private activeTasks: Map<string, DurableTask> = new Map();
  private reconnectAttempts = 0;

  constructor(config: LocalAgentClientConfig) {
    this.config = {
      ...config,
      heartbeatIntervalMs: config.heartbeatIntervalMs || 10000,
      pollIntervalMs: config.pollIntervalMs || 3000
    };
    this.executor = new TaskExecutor({
      allowedWorkspaces: config.allowedWorkspaces,
      projects: config.projects,
      projectRegistry: config.projectRegistry,
      projectsConfigFile: config.projectsConfigFile,
      allowRawShell: config.allowRawShell
    });
  }

  public start(): void {
    this.isRunning = true;
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  private connect(): void {
    if (!this.isRunning) return;

    const probe = EnvironmentProbe.probe({ allowRawShell: this.config.allowRawShell });
    const WSClass = (WebSocket as any).WebSocket || WebSocket;
    this.ws = new WSClass(this.config.gatewayUrl);

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.registerWithGateway(probe);
      this.startHeartbeat();
      this.startPollLoop(probe.capabilities);
    });

    this.ws.on('message', (data: Buffer | string) => {
      try {
        const msg: GatewayMessage = JSON.parse(data.toString('utf-8'));
        this.handleGatewayMessage(msg);
      } catch (err) {
        console.error('[AGENT] Failed to parse message from gateway:', err);
      }
    });

    this.ws.on('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.pollTimer) clearInterval(this.pollTimer);

      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: any) => {
      // Handled by close event
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private send(msg: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private registerWithGateway(probe: ReturnType<typeof EnvironmentProbe.probe>): void {
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

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

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

  private startPollLoop(capabilities: string[]): void {
    if (this.pollTimer) clearInterval(this.pollTimer);

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

  private handleGatewayMessage(msg: GatewayMessage): void {
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

  private async runAssignedTask(task: DurableTask): Promise<void> {
    try {
      this.send({
        type: 'TASK_PROGRESS',
        messageId: crypto.randomUUID(),
        timestamp: Date.now(),
        taskId: task.taskId,
        deviceId: this.config.deviceId,
        stage: 'RUNNING'
      });

      const logBuffer: string[] = [];
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
    } catch (err: any) {
      const errCode = err.code || (typeof err.message === 'string' && err.message.split(':')[0]) || 'LOCAL_TASK_EXECUTION_ERROR';
      this.send({
        type: 'TASK_FAIL',
        messageId: crypto.randomUUID(),
        timestamp: Date.now(),
        taskId: task.taskId,
        deviceId: this.config.deviceId,
        error: {
          code: errCode,
          message: err.message || 'Unknown execution error'
        }
      });
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }
}
