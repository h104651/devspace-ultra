import { WebSocket } from 'ws';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { TaskExecutor, TaskExecutorConfig } from './task-executor';
import { EnvironmentProbe } from './environment-probe';
import { ProjectRegistry, LocalProjectDefinition } from './project-registry';
import { isSideEffectCapability } from './capabilities';
import { DurableTask } from '../types/task';
import { GatewayMessage } from '../types/gateway';

export interface LocalAgentClientConfig {
  gatewayUrl: string; // e.g. "ws://localhost:4000/ws/agent"
  deviceId: string;
  token: string;
  name?: string;
  allowedWorkspaces?: string[];
  projects?: LocalProjectDefinition[];
  projectRegistry?: ProjectRegistry;
  projectsConfigFile?: string;
  allowRawShell?: boolean;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  onPolicyRejected?: (reason: string) => void;
}

export class LocalAgentClient {
  private config: LocalAgentClientConfig;
  private executor: TaskExecutor;
  private executorConfig: TaskExecutorConfig;
  private executorConfigRevision?: string;
  private rejectedExecutorConfigRevision?: string;
  private ws?: WebSocket;
  private isRunning = false;
  private isStopping = false;
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private registrationTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private activeTasks: Map<string, DurableTask> = new Map();
  private reconnectAttempts = 0;
  private readonly reconnectProof = crypto.randomBytes(32).toString('hex');
  private reconnectSequence = 0;
  private legacyRetryAvailable = false;
  private registeredSocket?: WebSocket;
  private taskSockets = new Map<string, WebSocket>();
  private lastPolicyError?: string;
  private policyRejectedNotified = false;

  constructor(config: LocalAgentClientConfig) {
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
    this.executor = new TaskExecutor(this.executorConfig);
    this.executorConfigRevision = this.computeExecutorConfigRevision();
  }

  public hasInFlightTasks(): boolean {
    return this.activeTasks.size > 0;
  }

  public getInFlightTasks(): Array<{ taskId: string; capability: string; isMutation: boolean }> {
    return Array.from(this.activeTasks.values()).map((task) => ({
      taskId: task.taskId,
      capability: task.capability,
      isMutation: isSideEffectCapability(task.capability)
    }));
  }

  private notifyPolicyRejected(reason: string): void {
    if (this.policyRejectedNotified) return;
    this.policyRejectedNotified = true;
    try {
      this.config.onPolicyRejected?.(reason);
    } catch {}
  }

  public start(): void {
    if (this.isRunning || this.isStopping || this.activeTasks.size > 0) return;
    this.isRunning = true;
    this.connect();
  }

  public async stop(options?: { timeoutMs?: number }): Promise<void> {
    if (this.isStopping) return;
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
      if (socket.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try {
              if (typeof (socket as any).terminate === 'function') (socket as any).terminate();
            } catch {}
            resolve();
          }, Math.min(timeout, 1500));

          socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });

          try {
            socket.close(1000, 'Agent shutting down gracefully');
          } catch {
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
  private computeExecutorConfigRevision(): string | undefined {
    if (this.executorConfig.projectRegistry || !this.executorConfig.projectsConfigFile) {
      return undefined;
    }

    try {
      const raw = fs.readFileSync(this.executorConfig.projectsConfigFile);
      return crypto.createHash('sha256').update(raw).digest('hex');
    } catch {
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
  private refreshExecutorConfigIfIdle(): boolean {
    if (this.activeTasks.size > 0) return false;

    const nextRevision = this.computeExecutorConfigRevision();
    if (!nextRevision || nextRevision === this.executorConfigRevision || nextRevision === this.rejectedExecutorConfigRevision) {
      return false;
    }

    try {
      const nextExecutor = new TaskExecutor(this.executorConfig);
      this.executor = nextExecutor;
      this.executorConfigRevision = nextRevision;
      this.rejectedExecutorConfigRevision = undefined;
      console.log('[AGENT] Reloaded changed local project configuration without restarting the agent.');
      return true;
    } catch (err: any) {
      this.rejectedExecutorConfigRevision = nextRevision;
      console.warn(`[AGENT] Ignoring invalid changed project configuration; keeping last good executor: ${err?.message || err}`);
      return false;
    }
  }

  private currentExecutionCapabilities(capabilities: string[]): string[] {
    const executionPolicyReadable = !this.executorConfig.projectsConfigFile || !!this.executorConfig.projectRegistry ||
      (!!this.executorConfigRevision && this.computeExecutorConfigRevision() === this.executorConfigRevision);
    const projects = executionPolicyReadable ? this.executor.getRegistry().listProjects().filter(p => p.enabled) : [];
    return capabilities.filter(cap => {
      if (cap !== 'local:run_tests' && cap !== 'local:build_project') return true;
      return projects.some(project => project.availableCapabilities.includes(cap));
    });
  }

  private connect(): void {
    if (!this.isRunning) return;

    const probe = EnvironmentProbe.probe({ allowRawShell: this.config.allowRawShell });
    const WSClass = (WebSocket as any).WebSocket || WebSocket;
    const socket: WebSocket = new WSClass(this.config.gatewayUrl);
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket || !this.isRunning) { socket.close(); return; }
      this.lastPolicyError = undefined;
      this.refreshExecutorConfigIfIdle();
      this.registerWithGateway(probe);
      this.registrationTimer = setTimeout(() => {
        if (this.ws === socket && this.registeredSocket !== socket && this.isRunning) socket.terminate();
      }, 15_000);
      this.startHeartbeat();
      this.startPollLoop(probe.capabilities);
    });

    socket.on('message', (data: Buffer | string) => {
      if (this.ws !== socket) return;
      try {
        const msg: GatewayMessage = JSON.parse(data.toString('utf-8'));
        this.handleGatewayMessage(msg, socket);
      } catch (err) {
        console.error('[AGENT] Failed to parse message from gateway:', err);
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== socket) return;
      const wasRegistered = this.registeredSocket === socket;
      this.ws = undefined;
      this.registeredSocket = undefined;
      if (this.registrationTimer) clearTimeout(this.registrationTimer);
      this.registrationTimer = undefined;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.pollTimer) clearInterval(this.pollTimer);

      const closeReason = reason?.toString() || '';
      if (wasRegistered && code === 1006) this.legacyRetryAvailable = true;
      // Compatibility with an old gateway only: wait out its heartbeat TTL once.
      if (this.isRunning && !this.lastPolicyError && code === 1008 && closeReason === 'Duplicate active device session' && this.legacyRetryAvailable) {
        this.legacyRetryAvailable = false;
        this.scheduleReconnect(46_000);
        return;
      }
      const policyReason =
        (code === 1008 && /duplicate|superseded|fenced|already registered|revoked|invalid reconnect identity|stale reconnect sequence|authentication failed/i.test(closeReason))
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
      if (this.isRunning) this.scheduleReconnect();
    });

    socket.on('error', (err: any) => {
      // Handled by close event
    });
  }

  private scheduleReconnect(minDelayMs = 0): void {
    this.reconnectAttempts++;
    const delay = Math.max(minDelayMs, Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000));
    this.reconnectTimeout = setTimeout(() => {
      if (this.activeTasks.size > 0) {
        // Old executors must finish before this process can obtain new work.
        if (this.isRunning) this.scheduleReconnect();
        return;
      }
      this.connect();
    }, delay);
  }

  private send(msg: any, socket = this.ws): void {
    if (socket && socket === this.ws && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
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
      capabilities: this.currentExecutionCapabilities(probe.capabilities),
      token: this.config.token,
      supportsAttemptFencing: true,
      reconnectProof: this.reconnectProof,
      reconnectSequence: ++this.reconnectSequence
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (this.registeredSocket !== this.ws) return;
      this.send({
        type: 'AGENT_HEARTBEAT',
        messageId: crypto.randomUUID(),
        timestamp: Date.now(),
        deviceId: this.config.deviceId,
        activeTaskIds: Array.from(this.activeTasks.keys()).filter(id => this.taskSockets.get(id) === this.ws),
        activeTaskAttempts: Array.from(this.activeTasks.values())
          .filter(task => this.taskSockets.get(task.taskId) === this.ws && !!task.activeAttemptId)
          .map(task => ({ taskId: task.taskId, attemptId: task.activeAttemptId! }))
      });
    }, this.config.heartbeatIntervalMs);
  }

  private startPollLoop(capabilities: string[]): void {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(() => {
      if (!this.isRunning || this.isStopping || this.registeredSocket !== this.ws || this.activeTasks.size > 0) return;
      this.refreshExecutorConfigIfIdle();
      this.send({
        type: 'TASK_CLAIM_POLL',
        messageId: crypto.randomUUID(),
        timestamp: Date.now(),
        deviceId: this.config.deviceId,
        supportedCapabilities: this.currentExecutionCapabilities(capabilities)
      });
    }, this.config.pollIntervalMs);
  }

  private handleGatewayMessage(msg: GatewayMessage, socket = this.ws): void {
    if (!socket || socket !== this.ws) return;
    if (msg.type === 'ERROR') {
      const errText = typeof (msg as any).error === 'string' ? (msg as any).error : '';
      if (/^(AUTH_FAILED|DEVICE_REVOKED|TOKEN_SUPERSEDED|SESSION_FENCED)\b/i.test(errText)) {
        this.lastPolicyError = errText;
        this.isRunning = false;
      }
      return;
    }
    if (msg.type === 'AGENT_REGISTERED') {
      if (msg.deviceId === this.config.deviceId) {
        this.registeredSocket = socket;
        if (this.registrationTimer) clearTimeout(this.registrationTimer);
        this.registrationTimer = undefined;
        this.reconnectAttempts = 0;
        this.legacyRetryAvailable = false;
      }
      return;
    }
    if (msg.type === 'TASK_ASSIGNED') {
      if (!this.isRunning || this.isStopping || this.registeredSocket !== socket || this.activeTasks.size > 0) return;
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

  private async runAssignedTask(task: DurableTask, socket = this.taskSockets.get(task.taskId)): Promise<void> {
    const sendForAttempt = (message: any) => {
      if (!socket || this.activeTasks.get(task.taskId) !== task || this.taskSockets.get(task.taskId) !== socket) return;
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

      const logBuffer: string[] = [];
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
        if (!this.currentExecutionCapabilities([task.capability]).includes(task.capability)) {
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
    } catch (err: any) {
      const errCode = err.code || (typeof err.message === 'string' && err.message.split(':')[0]) || 'LOCAL_TASK_EXECUTION_ERROR';
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
    } finally {
      if (this.activeTasks.get(task.taskId) === task) {
        this.activeTasks.delete(task.taskId);
        this.taskSockets.delete(task.taskId);
      }
      this.refreshExecutorConfigIfIdle();
    }
  }
}
