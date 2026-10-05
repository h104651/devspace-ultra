import { TaskStore } from '../storage/task-store';
import { ConnectionManager } from './connection-manager';
import { AuditLogger } from '../security/audit-logger';

export class LeaseMonitor {
  private taskStore: TaskStore;
  private connectionManager: ConnectionManager;
  private auditLogger: AuditLogger;
  private intervalMs: number;
  private timer?: NodeJS.Timeout;

  constructor(
    taskStore: TaskStore,
    connectionManager: ConnectionManager,
    auditLogger: AuditLogger,
    intervalMs = 10000
  ) {
    this.taskStore = taskStore;
    this.connectionManager = connectionManager;
    this.auditLogger = auditLogger;
    this.intervalMs = intervalMs;
  }

  public start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public tick(): void {
    // 1. Recover stale tasks
    const { recoveredCount, failedCount } = this.taskStore.recoverStaleTasks();
    if (recoveredCount > 0 || failedCount > 0) {
      this.auditLogger.log({
        actor: 'system',
        actorType: 'system',
        action: 'STALE_TASK_RECOVERY',
        result: 'SUCCESS',
        details: { recoveredCount, failedCount }
      });
    }

    // 2. Check connected agents heartbeat freshness
    const now = Date.now();
    const agents = this.connectionManager.getConnectedAgents();
    for (const agent of agents) {
      if (now - agent.lastHeartbeatAt > 45000) {
        // Agent timed out
        agent.socket.close();
      }
    }
  }
}
