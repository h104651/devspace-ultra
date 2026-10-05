import * as crypto from 'crypto';
import { SwarmTaskSpec, SwarmWorkerState } from '../types/swarm';
import { WakeBridge } from './wake-bridge';
import { TaskStore } from '../storage/task-store';

export class SwarmOrchestrator {
  private workers: Map<string, SwarmWorkerState> = new Map();
  private wakeBridge: WakeBridge;
  private taskStore: TaskStore;
  private workerLeaseDurationMs: number;

  constructor(taskStore: TaskStore, wakeBridge?: WakeBridge, workerLeaseDurationMs = 45000) {
    this.taskStore = taskStore;
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
    // Check for an available idle worker matching required role
    const idleWorkers = Array.from(this.workers.values()).filter(w => {
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
      worker.status = 'busy';
      worker.currentTaskId = task.taskId;
      worker.lastClaimAt = Date.now();
      worker.leaseExpiresAt = Date.now() + this.workerLeaseDurationMs;

      this.taskStore.claimTask(worker.workerId, ['swarm:dispatch']);
      this.wakeBridge.emitWake(`swarm:worker:${worker.workerId}`, worker.workerId, 'WAKE', { taskId: task.taskId, spec });
      return { taskId: task.taskId, assignedWorkerId: worker.workerId };
    }

    // Queued for next available worker
    this.wakeBridge.emitWake('swarm:task_queued', undefined, 'NOTIFY', { taskId: task.taskId });
    return { taskId: task.taskId };
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
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
      worker.totalTasksCompleted++;
    }
    const success = this.taskStore.completeTask(taskId, result);
    this.wakeBridge.emitWake('swarm:task_completed', workerId, 'NOTIFY', { taskId, result });
    return success;
  }

  public failWorkerTask(workerId: string, taskId: string, error: { code: string; message: string }): boolean {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'idle';
      worker.currentTaskId = undefined;
      worker.totalTasksFailed++;
    }
    const success = this.taskStore.failTask(taskId, error);
    this.wakeBridge.emitWake('swarm:task_failed', workerId, 'NOTIFY', { taskId, error });
    return success;
  }

  public recycleWorker(workerId: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    if (worker.currentTaskId) {
      this.taskStore.cancelTask(worker.currentTaskId, 'Worker recycled');
    }

    worker.status = 'idle';
    worker.currentTaskId = undefined;
    worker.lastHeartbeatAt = Date.now();
    this.wakeBridge.emitWake('swarm:worker_recycled', workerId, 'RECYCLE');
    return true;
  }

  public resizeSwarm(targetCount: number, defaultRole = 'general'): void {
    const current = this.listWorkers();
    if (current.length < targetCount) {
      const need = targetCount - current.length;
      for (let i = 0; i < need; i++) {
        this.registerWorker(`Worker-${current.length + i + 1}`, defaultRole);
      }
    } else if (current.length > targetCount) {
      const removeCount = current.length - targetCount;
      const idle = current.filter(w => w.status === 'idle').slice(0, removeCount);
      for (const w of idle) {
        this.workers.delete(w.workerId);
      }
    }
  }
}
