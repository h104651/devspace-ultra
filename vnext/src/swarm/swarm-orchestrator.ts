import * as crypto from 'crypto';
import { SwarmTaskSpec, SwarmWorkerState } from '../types/swarm';
import { WakeBridge } from './wake-bridge';
import { TaskStore } from '../storage/task-store';

export class SwarmOrchestrator {
  private workers: Map<string, SwarmWorkerState> = new Map();
  private wakeBridge: WakeBridge;
  private workerLeaseDurationMs: number;

  constructor(private taskStore: TaskStore, wakeBridge?: WakeBridge, workerLeaseDurationMs = 45000) {
    this.wakeBridge = wakeBridge || new WakeBridge();
    this.workerLeaseDurationMs = workerLeaseDurationMs;
  }

  public registerWorker(name: string, role: string, capabilities: string[] = ['general']): SwarmWorkerState {
    const workerId = `worker-${crypto.randomBytes(4).toString('hex')}`;
    const worker: SwarmWorkerState = {
      workerId,
      name,
      role,
      capabilities,
      status: 'idle',
      totalTasksCompleted: 0,
      totalTasksFailed: 0
    };
    this.workers.set(workerId, worker);
    this.wakeBridge.emitWake('swarm:worker_registered', workerId, 'NOTIFY', { role, capabilities });
    return worker;
  }

  public getWorker(workerId: string): SwarmWorkerState | undefined {
    return this.workers.get(workerId);
  }

  public listWorkers(): SwarmWorkerState[] {
    return Array.from(this.workers.values());
  }

  public dispatchTask(spec: SwarmTaskSpec): { taskId: string; assignedWorkerId?: string } {
    const idleWorkers = this.listWorkers().filter(w => {
      if (w.status !== 'idle') return false;
      if (spec.roleRequired && w.role !== spec.roleRequired) return false;
      return true;
    });

    const task = this.taskStore.createTask({
      backend: 'swarm',
      capability: 'swarm:dispatch',
      payload: spec,
      leaseDurationMs: spec.timeoutMs || this.workerLeaseDurationMs
    });

    if (idleWorkers.length > 0) {
      const worker = idleWorkers[0];
      const claimed = this.taskStore.claimTaskById(task.taskId, worker.workerId, spec.timeoutMs || this.workerLeaseDurationMs);
      if (claimed) {
        worker.status = 'busy';
        worker.currentTaskId = task.taskId;
        worker.lastClaimAt = Date.now();
        worker.leaseExpiresAt = claimed.lease?.leaseExpiresAt;
        this.wakeBridge.emitWake(`swarm:worker:${worker.workerId}`, worker.workerId, 'WAKE', { taskId: task.taskId, spec });
        return { taskId: task.taskId, assignedWorkerId: worker.workerId };
      }
    }

    this.wakeBridge.emitWake('swarm:task_queued', undefined, 'NOTIFY', { taskId: task.taskId });
    return { taskId: task.taskId };
  }

  public claimNextTask(workerId: string): any | undefined {
    this.taskStore.recoverStaleTasks();
    const worker = this.workers.get(workerId);
    if (!worker || worker.status === 'offline' || worker.status === 'stale') return undefined;

    if (worker.currentTaskId) {
      const current = this.taskStore.getTask(worker.currentTaskId);
      if (current && ['claimed', 'acknowledged', 'running'].includes(current.status)) return current;
      worker.currentTaskId = undefined;
      worker.status = 'idle';
    }

    const candidates = this.taskStore.listTasks({ backend: 'swarm' })
      .filter(t => t.status === 'queued' && t.capability === 'swarm:dispatch')
      .filter(t => {
        const roleRequired = (t.payload as any)?.roleRequired;
        return !roleRequired || roleRequired === worker.role;
      })
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));

    const task = candidates[0];
    if (!task) return undefined;

    const timeoutMs = (task.payload as any)?.timeoutMs || this.workerLeaseDurationMs;
    const claimed = this.taskStore.claimTaskById(task.taskId, workerId, timeoutMs);
    if (!claimed) return undefined;

    worker.status = 'busy';
    worker.currentTaskId = claimed.taskId;
    worker.lastClaimAt = Date.now();
    worker.leaseExpiresAt = claimed.lease?.leaseExpiresAt;
    return claimed;
  }

  public acknowledgeTask(workerId: string, taskId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.currentTaskId !== taskId) return false;
    worker.lastHeartbeatAt = Date.now();
    worker.leaseExpiresAt = Date.now() + this.workerLeaseDurationMs;
    return this.taskStore.acknowledgeTask(taskId, workerId);
  }

  public completeWorkerTask(workerId: string, taskId: string, result: any): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.currentTaskId !== taskId) return false;
    worker.status = 'idle';
    worker.currentTaskId = undefined;
    worker.totalTasksCompleted++;
    const success = this.taskStore.completeTask(taskId, result);
    this.wakeBridge.emitWake('swarm:task_completed', workerId, 'NOTIFY', { taskId });
    return success;
  }

  public failWorkerTask(workerId: string, taskId: string, error: { code: string; message: string }): boolean {
    const worker = this.workers.get(workerId);
    if (!worker || worker.currentTaskId !== taskId) return false;
    worker.status = 'idle';
    worker.currentTaskId = undefined;
    worker.totalTasksFailed++;
    const success = this.taskStore.failTask(taskId, error);
    this.wakeBridge.emitWake('swarm:task_failed', workerId, 'NOTIFY', { taskId });
    return success;
  }

  public recycleWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    if (worker.currentTaskId) this.taskStore.cancelTask(worker.currentTaskId, 'Worker recycled');
    worker.status = 'idle';
    worker.currentTaskId = undefined;
    worker.lastHeartbeatAt = Date.now();
    this.wakeBridge.emitWake('swarm:worker_recycled', workerId, 'RECYCLE');
    return true;
  }

  public resizeSwarm(targetCount: number, defaultRole = 'general'): void {
    const current = this.listWorkers();
    if (current.length < targetCount) {
      for (let i = current.length; i < targetCount; i++) this.registerWorker(`Worker-${i + 1}`, defaultRole);
    } else if (current.length > targetCount) {
      const removeCount = current.length - targetCount;
      const idle = current.filter(w => w.status === 'idle').slice(0, removeCount);
      for (const w of idle) this.workers.delete(w.workerId);
    }
  }
}
