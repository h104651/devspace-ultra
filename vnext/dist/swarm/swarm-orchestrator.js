"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwarmOrchestrator = void 0;
const crypto = __importStar(require("crypto"));
const wake_bridge_1 = require("./wake-bridge");
class SwarmOrchestrator {
    taskStore;
    workers = new Map();
    wakeBridge;
    workerLeaseDurationMs;
    constructor(taskStore, wakeBridge, workerLeaseDurationMs = 45000) {
        this.taskStore = taskStore;
        this.wakeBridge = wakeBridge || new wake_bridge_1.WakeBridge();
        this.workerLeaseDurationMs = workerLeaseDurationMs;
    }
    registerWorker(name, role, capabilities = ['general']) {
        const workerId = `worker-${crypto.randomBytes(4).toString('hex')}`;
        const worker = {
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
    getWorker(workerId) {
        return this.workers.get(workerId);
    }
    listWorkers() {
        return Array.from(this.workers.values());
    }
    dispatchTask(spec) {
        const idleWorkers = this.listWorkers().filter(w => {
            if (w.status !== 'idle')
                return false;
            if (spec.roleRequired && w.role !== spec.roleRequired)
                return false;
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
    claimNextTask(workerId) {
        this.taskStore.recoverStaleTasks();
        const worker = this.workers.get(workerId);
        if (!worker || worker.status === 'offline' || worker.status === 'stale')
            return undefined;
        if (worker.currentTaskId) {
            const current = this.taskStore.getTask(worker.currentTaskId);
            if (current && ['claimed', 'acknowledged', 'running'].includes(current.status))
                return current;
            worker.currentTaskId = undefined;
            worker.status = 'idle';
        }
        const candidates = this.taskStore.listTasks({ backend: 'swarm' })
            .filter(t => t.status === 'queued' && t.capability === 'swarm:dispatch')
            .filter(t => {
            const roleRequired = t.payload?.roleRequired;
            return !roleRequired || roleRequired === worker.role;
        })
            .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
        const task = candidates[0];
        if (!task)
            return undefined;
        const timeoutMs = task.payload?.timeoutMs || this.workerLeaseDurationMs;
        const claimed = this.taskStore.claimTaskById(task.taskId, workerId, timeoutMs);
        if (!claimed)
            return undefined;
        worker.status = 'busy';
        worker.currentTaskId = claimed.taskId;
        worker.lastClaimAt = Date.now();
        worker.leaseExpiresAt = claimed.lease?.leaseExpiresAt;
        return claimed;
    }
    acknowledgeTask(workerId, taskId) {
        const worker = this.workers.get(workerId);
        if (!worker || worker.currentTaskId !== taskId)
            return false;
        worker.lastHeartbeatAt = Date.now();
        worker.leaseExpiresAt = Date.now() + this.workerLeaseDurationMs;
        return this.taskStore.acknowledgeTask(taskId, workerId);
    }
    completeWorkerTask(workerId, taskId, result) {
        const worker = this.workers.get(workerId);
        if (!worker || worker.currentTaskId !== taskId)
            return false;
        worker.status = 'idle';
        worker.currentTaskId = undefined;
        worker.totalTasksCompleted++;
        const success = this.taskStore.completeTask(taskId, result);
        this.wakeBridge.emitWake('swarm:task_completed', workerId, 'NOTIFY', { taskId });
        return success;
    }
    failWorkerTask(workerId, taskId, error) {
        const worker = this.workers.get(workerId);
        if (!worker || worker.currentTaskId !== taskId)
            return false;
        worker.status = 'idle';
        worker.currentTaskId = undefined;
        worker.totalTasksFailed++;
        const success = this.taskStore.failTask(taskId, error);
        this.wakeBridge.emitWake('swarm:task_failed', workerId, 'NOTIFY', { taskId });
        return success;
    }
    recycleWorker(workerId) {
        const worker = this.workers.get(workerId);
        if (!worker)
            return false;
        if (worker.currentTaskId)
            this.taskStore.cancelTask(worker.currentTaskId, 'Worker recycled');
        worker.status = 'idle';
        worker.currentTaskId = undefined;
        worker.lastHeartbeatAt = Date.now();
        this.wakeBridge.emitWake('swarm:worker_recycled', workerId, 'RECYCLE');
        return true;
    }
    resizeSwarm(targetCount, defaultRole = 'general') {
        const current = this.listWorkers();
        if (current.length < targetCount) {
            for (let i = current.length; i < targetCount; i++)
                this.registerWorker(`Worker-${i + 1}`, defaultRole);
        }
        else if (current.length > targetCount) {
            const removeCount = current.length - targetCount;
            const idle = current.filter(w => w.status === 'idle').slice(0, removeCount);
            for (const w of idle)
                this.workers.delete(w.workerId);
        }
    }
}
exports.SwarmOrchestrator = SwarmOrchestrator;
