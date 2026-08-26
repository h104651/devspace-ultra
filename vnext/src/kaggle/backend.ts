import * as path from 'path';
import * as fs from 'fs';
import { KaggleClient } from './client';
import { TaskStore } from '../storage/task-store';
import { ArtifactStore } from '../storage/artifact-store';
import { KaggleTaskPayload, KaggleTaskResult } from '../types/kaggle';
import { DurableTask } from '../types/task';

export type KagglePollScheduler = (delayMs: number) => void | Promise<void>;

export class KaggleBackend {
  private client: KaggleClient;
  private workDirBase = '';
  private activeLocalPollers: Set<string> = new Set();

  constructor(
    private taskStore: TaskStore,
    private artifactStore: ArtifactStore,
    client?: KaggleClient,
    storageDir?: string,
    private pollIntervalMs = 15000,
    private externalScheduler?: KagglePollScheduler
  ) {
    this.client = client || new KaggleClient();
    if (storageDir && storageDir !== ':memory:') {
      this.workDirBase = path.join(storageDir, 'kaggle_runs');
      try { if (!fs.existsSync(this.workDirBase)) fs.mkdirSync(this.workDirBase, { recursive: true }); } catch {}
    }
  }

  public getClient(): KaggleClient { return this.client; }

  public async submitKaggleTask(task: DurableTask<KaggleTaskPayload>): Promise<{ taskId: string; kernelSlug: string; status: string }> {
    const payload = task.payload;
    const taskWorkDir = this.workDirBase ? path.join(this.workDirBase, task.taskId) : '';
    this.taskStore.appendLogs(task.taskId, [
      `Initiating Kaggle kernel submission for slug: ${payload.kernelSlug}`,
      `GPU requested: ${!!payload.enableGpu}, Internet: ${payload.enableInternet !== false}`
    ]);

    const pushResult = typeof (this.client as any).pushKernel === 'function'
      ? ((this.client as any).pushKernel.length === 1
          ? await (this.client as any).pushKernel(payload)
          : await (this.client as any).pushKernel(taskWorkDir || payload, payload))
      : await (this.client as any).pushKernel(payload);

    if (!pushResult.success) {
      this.taskStore.failTask(task.taskId, { code: pushResult.error?.includes('QUOTA') ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_PUSH_FAILED', message: pushResult.error || 'Failed to push kernel to Kaggle' });
      throw new Error(pushResult.error || 'Kaggle push failed');
    }

    this.taskStore.startTask(task.taskId, 'kaggle-backend');
    this.taskStore.appendLogs(task.taskId, [`Kernel successfully submitted to Kaggle. URL: ${pushResult.kernelUrl}`, 'Scheduling status monitor.']);
    await this.schedulePoll(task.taskId, payload.kernelSlug);
    return { taskId: task.taskId, kernelSlug: payload.kernelSlug, status: 'running' };
  }

  private async schedulePoll(taskId: string, kernelSlug: string): Promise<void> {
    if (this.externalScheduler) {
      await this.externalScheduler(this.pollIntervalMs);
      return;
    }
    if (this.activeLocalPollers.has(taskId)) return;
    this.activeLocalPollers.add(taskId);
    setTimeout(async () => {
      this.activeLocalPollers.delete(taskId);
      try { await this.pollKaggleTaskOnce(taskId, kernelSlug, true); }
      catch (err) { console.error(`Error polling Kaggle task ${taskId}:`, err); }
    }, this.pollIntervalMs);
  }

  public async pollKaggleTaskOnce(taskId: string, kernelSlug: string, reschedule = false): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task || ['succeeded', 'failed', 'cancelled', 'stale'].includes(task.status)) return false;

    try {
      const statusRes = await (this.client as any).getKernelStatus(kernelSlug);
      this.taskStore.appendLogs(taskId, [`Kaggle execution status: ${statusRes.status} (${statusRes.rawMessage || ''})`]);

      if (statusRes.status === 'complete') {
        await this.finalizeKaggleRun(taskId, kernelSlug);
        return false;
      }
      if (statusRes.status === 'error') {
        this.taskStore.failTask(taskId, { code: 'KAGGLE_RUN_FAILED', message: `Kaggle execution resulted in error: ${statusRes.rawMessage || 'unknown error'}` });
        return false;
      }
      if (statusRes.status === 'quotaExceeded') {
        this.taskStore.failTask(taskId, { code: 'RESOURCE_QUOTA_EXCEEDED', message: 'Kaggle GPU quota limit exceeded during execution' });
        return false;
      }

      if (reschedule) await this.schedulePoll(taskId, kernelSlug);
      return true;
    } catch (err: any) {
      this.taskStore.appendLogs(taskId, [`Kaggle status poll failed: ${err.message || String(err)}`]);
      if (reschedule) await this.schedulePoll(taskId, kernelSlug);
      return true;
    }
  }

  private async finalizeKaggleRun(taskId: string, kernelSlug: string) {
    const outputDir = this.workDirBase ? path.join(this.workDirBase, taskId, 'outputs') : '';
    const downloadRes = await (this.client as any).downloadKernelOutput(kernelSlug, outputDir);
    const resultSummary: KaggleTaskResult = { kernelSlug, status: 'complete', outputFiles: [] };

    if (downloadRes.success && Array.isArray(downloadRes.files)) {
      for (const item of downloadRes.files as any[]) {
        try {
          const fileName = typeof item === 'string' ? path.basename(item) : item.name;
          const content = typeof item === 'string' ? (fs.existsSync(item) ? fs.readFileSync(item) : '') : item.content || '';
          const type = fileName.endsWith('.json') ? 'json' : fileName.endsWith('.csv') ? 'csv' : fileName.endsWith('.ipynb') ? 'notebook' : 'log';
          const mimeType = fileName.endsWith('.json') ? 'application/json' : fileName.endsWith('.csv') ? 'text/csv' : fileName.endsWith('.ipynb') ? 'application/x-ipynb+json' : 'text/plain';
          const art = this.artifactStore.saveArtifact(taskId, fileName, content, type as any, mimeType);
          this.taskStore.addArtifact(taskId, art.id);
          resultSummary.outputFiles.push({ fileName, sizeBytes: art.sizeBytes });
          if (fileName === 'result.json' || fileName === 'metrics.json') {
            try {
              const text = Buffer.isBuffer(content) ? content.toString('utf-8') : typeof content === 'string' ? content : '';
              resultSummary.metrics = JSON.parse(text);
            } catch {}
          }
        } catch (err) { console.error('Failed to ingest Kaggle artifact:', err); }
      }
    }

    this.taskStore.completeTask(taskId, resultSummary);
    this.taskStore.appendLogs(taskId, [`Kaggle kernel run finalized successfully. Ingested ${resultSummary.outputFiles.length} artifacts.`]);
  }
}
