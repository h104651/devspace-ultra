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
        this.taskStore.startTask(task.taskId, 'kaggle-backend');
        this.taskStore.appendLogs(task.taskId, [`Kernel successfully submitted to Kaggle. URL: ${pushResult.kernelUrl}`, 'Scheduling Kaggle status monitor.']);
        await this.schedulePoll(task.taskId, payload.kernelSlug);
        return { taskId: task.taskId, kernelSlug: payload.kernelSlug, status: 'running' };
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
        const task = this.taskStore.getTask(taskId);
        if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.status))
            return false;
        try {
            const statusRes = await this.client.getKernelStatus(kernelSlug);
            this.taskStore.appendLogs(taskId, [`Kaggle execution status: ${statusRes.status} (${statusRes.rawMessage || ''})`]);
            if (statusRes.status === 'complete') {
                await this.finalizeKaggleRun(taskId, kernelSlug);
                return false;
            }
            if (statusRes.status === 'error' || statusRes.status === 'quotaExceeded') {
                this.taskStore.failTask(taskId, {
                    code: statusRes.status === 'quotaExceeded' ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_RUN_FAILED',
                    message: statusRes.status === 'quotaExceeded' ? 'Kaggle GPU quota limit exceeded during execution' : `Kaggle execution resulted in error: ${statusRes.rawMessage}`
                });
                return false;
            }
            if (reschedule)
                await this.schedulePoll(taskId, kernelSlug);
            return true;
        }
        catch (err) {
            this.taskStore.appendLogs(taskId, [`Kaggle status poll failed: ${err.message || String(err)}`]);
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
                    if (fileName === 'result.json' || fileName === 'metrics.json') {
                        try {
                            const text = Buffer.isBuffer(content) ? content.toString('utf-8') : typeof content === 'string' ? content : '';
                            resultSummary.metrics = JSON.parse(text);
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
}
exports.KaggleBackend = KaggleBackend;
