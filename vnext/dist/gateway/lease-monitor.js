"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeaseMonitor = void 0;
class LeaseMonitor {
    taskStore;
    connectionManager;
    auditLogger;
    intervalMs;
    timer;
    constructor(taskStore, connectionManager, auditLogger, intervalMs = 10000) {
        this.taskStore = taskStore;
        this.connectionManager = connectionManager;
        this.auditLogger = auditLogger;
        this.intervalMs = intervalMs;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            this.tick();
        }, this.intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    tick() {
        // 1. Recover stale tasks
        let recoveredCount = 0;
        let failedCount = 0;
        try {
            ({ recoveredCount, failedCount } = this.taskStore.recoverStaleTasks());
        }
        catch (err) {
            if (!(err instanceof Error) || !err.message.startsWith('LOCAL_TASK_PERSISTENCE_UNAVAILABLE:'))
                throw err;
            // The TaskStore has latched the fault. Do not crash the interval callback
            // or automatically restart the process to bypass the dispatch gate.
            console.error('Local task recovery blocked: durable state reconciliation required.');
        }
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
exports.LeaseMonitor = LeaseMonitor;
