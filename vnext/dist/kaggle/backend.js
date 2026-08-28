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
exports.KaggleBackend = void 0;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const client_1 = require("./client");
class KaggleBackend {
    client;
    taskStore;
    artifactStore;
    workDirBase;
    pollIntervalMs;
    pollScheduler;
    activePollers = new Map();
    constructor(taskStore, artifactStore, client, storageDir, pollIntervalMs = 15000, pollScheduler) {
        this.taskStore = taskStore;
        this.artifactStore = artifactStore;
        this.client = client || new client_1.KaggleClient();
        this.pollIntervalMs = pollIntervalMs;
        this.pollScheduler = pollScheduler;
        if (storageDir && storageDir !== ':memory:') {
            this.workDirBase = path.join(storageDir, 'kaggle_runs');
            try {
                if (!fs.existsSync(this.workDirBase))
                    fs.mkdirSync(this.workDirBase, { recursive: true });
            }
            catch { }
        }
    }
    getClient() { return this.client; }
    async submitKaggleTask(task) {
        const payload = task.payload;
        const taskWorkDir = this.workDirBase ? path.join(this.workDirBase, task.taskId) : '';
        this.taskStore.appendLogs(task.taskId, [
            `Initiating Kaggle kernel submission for slug: ${payload.kernelSlug}`,
            `GPU requested: ${!!payload.enableGpu}, Internet: ${payload.enableInternet !== false}`
        ]);
        const pushResult = this.client.pushKernel.length === 1
            ? await this.client.pushKernel(payload)
            : await this.client.pushKernel(taskWorkDir || payload, payload);
        if (!pushResult.success) {
            this.taskStore.failTask(task.taskId, { code: pushResult.error?.includes('QUOTA') ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_PUSH_FAILED', message: pushResult.error || 'Failed to push kernel to Kaggle' });
            throw new Error(pushResult.error);
        }
        const actualSlug = pushResult.kernelSlug || payload.kernelSlug;
        payload.kernelSlug = actualSlug;
        this.taskStore.startTask(task.taskId, 'kaggle-backend');
        // Attach ExternalRunInfo to durable task
        const externalRun = {
            provider: 'kaggle',
            kernelRef: actualSlug,
            versionNumber: pushResult.versionNumber || 'unknown',
            submittedAt: Date.now(),
            lastPolledAt: Date.now(),
            lastRemoteStatus: 'queued',
            reconciliationState: 'active'
        };
        this.taskStore.setExternalRun(task.taskId, externalRun);
        this.taskStore.updateTask(task.taskId, {
            metadata: {
                ...task.metadata,
                createsNewKaggleVersion: true,
                createdVersionNumber: pushResult.versionNumber || 'unknown',
                kernelRef: actualSlug
            }
        });
        this.taskStore.appendLogs(task.taskId, [
            `Kernel successfully submitted to Kaggle. URL: ${pushResult.kernelUrl}`,
            `Version: ${pushResult.versionNumber || 'unknown'}`,
            'Scheduling Kaggle status monitor.'
        ]);
        await this.schedulePoll(task.taskId, actualSlug);
        return { taskId: task.taskId, kernelSlug: actualSlug, status: 'running', versionNumber: pushResult.versionNumber };
    }
    async schedulePoll(taskId, kernelSlug) {
        if (this.pollScheduler) {
            await this.pollScheduler.schedule(taskId, kernelSlug, this.pollIntervalMs);
            return;
        }
        if (this.activePollers.has(taskId))
            return;
        const timer = setTimeout(async () => {
            this.activePollers.delete(taskId);
            await this.pollKaggleTask(taskId, kernelSlug, true);
        }, this.pollIntervalMs);
        this.activePollers.set(taskId, timer);
    }
    async pollKaggleTask(taskId, kernelSlug, reschedule = false) {
        return this.reconcileTask(taskId, reschedule);
    }
    /**
     * Reconciles an externally-submitted Kaggle task against the authoritative remote provider.
     * Never re-pushes or duplicates kernels on Kaggle.
     */
    async reconcileTask(taskId, reschedule = false) {
        const task = this.taskStore.getTask(taskId);
        if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.status))
            return false;
        const kernelSlug = task.externalRun?.kernelRef || task.payload?.kernelSlug;
        if (!kernelSlug) {
            this.taskStore.failTask(taskId, {
                code: 'KAGGLE_RECONCILIATION_FAILED',
                message: 'No kernel slug associated with task'
            });
            return false;
        }
        try {
            const statusRes = await this.client.getKernelStatus(kernelSlug);
            const now = Date.now();
            const updatedExternalRun = {
                ...(task.externalRun || { provider: 'kaggle', submittedAt: task.createdAt }),
                kernelRef: kernelSlug,
                lastPolledAt: now,
                lastRemoteStatus: statusRes.status
            };
            this.taskStore.appendLogs(taskId, [`Kaggle execution status: ${statusRes.status} (${statusRes.rawMessage || ''})`]);
            if (statusRes.status === 'complete') {
                updatedExternalRun.reconciliationState = 'completed';
                this.taskStore.setExternalRun(taskId, updatedExternalRun);
                await this.finalizeKaggleRun(taskId, kernelSlug);
                return false;
            }
            if (statusRes.status === 'error' || statusRes.status === 'quotaExceeded') {
                updatedExternalRun.reconciliationState = 'failed';
                this.taskStore.setExternalRun(taskId, updatedExternalRun);
                this.taskStore.failTask(taskId, {
                    code: statusRes.status === 'quotaExceeded' ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_RUN_FAILED',
                    message: statusRes.status === 'quotaExceeded'
                        ? 'Kaggle GPU quota limit exceeded during execution'
                        : `Kaggle execution resulted in error: ${statusRes.rawMessage}`
                }, { retryable: false });
                return false;
            }
            if (statusRes.status === 'cancelled' || statusRes.status === 'cancelAcknowledged') {
                updatedExternalRun.reconciliationState = 'failed';
                this.taskStore.setExternalRun(taskId, updatedExternalRun);
                this.taskStore.cancelTask(taskId, 'Kaggle execution cancelled remotely');
                return false;
            }
            // If running or queued, preserve active state and reschedule poll
            updatedExternalRun.reconciliationState = 'active';
            this.taskStore.setExternalRun(taskId, updatedExternalRun);
            if (reschedule)
                await this.schedulePoll(taskId, kernelSlug);
            return true;
        }
        catch (err) {
            this.taskStore.appendLogs(taskId, [`Kaggle status poll failed: ${err.message || String(err)}`]);
            const updatedExternalRun = {
                ...(task.externalRun || { provider: 'kaggle', submittedAt: task.createdAt }),
                kernelRef: kernelSlug,
                lastPolledAt: Date.now(),
                reconciliationState: 'pending'
            };
            this.taskStore.setExternalRun(taskId, updatedExternalRun);
            if (reschedule)
                await this.schedulePoll(taskId, kernelSlug);
            return true;
        }
    }
    async finalizeKaggleRun(taskId, kernelSlug) {
        const outputDir = this.workDirBase ? path.join(this.workDirBase, taskId, 'outputs') : '';
        const downloadRes = await this.client.downloadKernelOutput(kernelSlug, outputDir);
        const resultSummary = { kernelSlug, status: 'complete', outputFiles: [] };
        if (downloadRes.success && Array.isArray(downloadRes.files)) {
            for (const item of downloadRes.files) {
                try {
                    const fileName = typeof item === 'string' ? path.basename(item) : item.name;
                    const content = typeof item === 'string' ? (fs.existsSync(item) ? fs.readFileSync(item) : '') : item.content || '';
                    const type = fileName.endsWith('.json') ? 'json' : fileName.endsWith('.csv') ? 'csv' : fileName.endsWith('.ipynb') ? 'notebook' : 'log';
                    const mimeType = fileName.endsWith('.json') ? 'application/json' : fileName.endsWith('.csv') ? 'text/csv' : fileName.endsWith('.ipynb') ? 'application/x-ipynb+json' : 'text/plain';
                    const art = this.artifactStore.saveArtifact(taskId, fileName, content, type, mimeType);
                    this.taskStore.addArtifact(taskId, {
                        id: art.id,
                        name: art.name,
                        type: art.type,
                        sizeBytes: art.sizeBytes,
                        mimeType: art.mimeType || mimeType,
                        preview: art.preview,
                        downloadUrl: `/api/artifacts/${encodeURIComponent(art.id)}`
                    });
                    resultSummary.outputFiles.push({ fileName, sizeBytes: art.sizeBytes });
                    if (fileName === 'stdout.log' || fileName === 'stderr.log') {
                        const logText = Buffer.isBuffer(content) ? content.toString('utf-8') : typeof content === 'string' ? content : '';
                        if (logText) {
                            const lines = logText.split('\n').filter(l => l.trim().length > 0);
                            this.taskStore.appendLogs(taskId, lines);
                        }
                    }
                    if (fileName === 'result.json' || fileName === 'metrics.json') {
                        try {
                            const text = Buffer.isBuffer(content) ? content.toString('utf-8') : typeof content === 'string' ? content : '';
                            const parsed = JSON.parse(text);
                            resultSummary.metrics = parsed;
                            resultSummary.result = parsed;
                        }
                        catch { }
                    }
                }
                catch (err) {
                    console.error('Failed to ingest Kaggle artifact:', err);
                }
            }
        }
        this.taskStore.completeTask(taskId, resultSummary);
        this.taskStore.appendLogs(taskId, [`Kaggle kernel run finalized successfully. Ingested ${resultSummary.outputFiles.length} artifacts.`]);
    }
    /**
     * Reconciles all non-terminal tasks associated with an external Kaggle run on system hydration/startup.
     */
    async reconcileDanglingTasks() {
        let count = 0;
        const nonTerminalTasks = this.taskStore.listTasks().filter(t => ['queued', 'claimed', 'acknowledged', 'running'].includes(t.status) &&
            t.externalRun &&
            t.externalRun.provider === 'kaggle');
        for (const task of nonTerminalTasks) {
            try {
                await this.reconcileTask(task.taskId, true);
                count++;
            }
            catch (err) {
                console.warn(`[KaggleBackend] Failed to reconcile dangling task ${task.taskId}:`, err.message);
            }
        }
        return { reconciledCount: count };
    }
}
exports.KaggleBackend = KaggleBackend;
