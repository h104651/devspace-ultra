import * as path from 'path';
import * as fs from 'fs';
import { KaggleClient } from './client';
import { TaskStore } from '../storage/task-store';
import { ArtifactStore } from '../storage/artifact-store';
import { KaggleTaskPayload, KaggleTaskResult } from '../types/kaggle';
import { DurableTask } from '../types/task';

export class KaggleBackend {
  private client: KaggleClient;
  private taskStore: TaskStore;
  private artifactStore: ArtifactStore;
  private workDirBase: string;
  private pollIntervalMs: number;
  private activePollers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    taskStore: TaskStore,
    artifactStore: ArtifactStore,
    client?: KaggleClient,
    storageDir?: string,
    pollIntervalMs = 15000
  ) {
    this.taskStore = taskStore;
    this.artifactStore = artifactStore;
    this.client = client || new KaggleClient();
    this.pollIntervalMs = pollIntervalMs;

    if (storageDir && storageDir !== ':memory:') {
      this.workDirBase = path.join(storageDir, 'kaggle_runs');
      try {
        if (!fs.existsSync(this.workDirBase)) {
          fs.mkdirSync(this.workDirBase, { recursive: true });
        }
      } catch {}
    }
  }

  public getClient(): KaggleClient {
    return this.client;
  }

  /**
   * Submits a Kaggle task asynchronously. Returns immediately.
   */
  public async submitKaggleTask(task: DurableTask<KaggleTaskPayload>): Promise<{
    taskId: string;
    kernelSlug: string;
    status: string;
  }> {
    const payload = task.payload;
    const taskWorkDir = this.workDirBase ? path.join(this.workDirBase, task.taskId) : '';

    this.taskStore.appendLogs(task.taskId, [
      `Initiating Kaggle kernel submission for slug: ${payload.kernelSlug}`,
      `GPU requested: ${!!payload.enableGpu}, Internet: ${payload.enableInternet !== false}`
    ]);

    // Push kernel to Kaggle
    const pushResult = typeof (this.client as any).pushKernel === 'function'
      ? ((this.client as any).pushKernel.length === 1
          ? await (this.client as any).pushKernel(payload)
          : await (this.client as any).pushKernel(taskWorkDir || payload, payload))
      : await (this.client as any).pushKernel(payload);

    if (!pushResult.success) {
      this.taskStore.failTask(task.taskId, {
        code: pushResult.error?.includes('QUOTA') ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_PUSH_FAILED',
        message: pushResult.error || 'Failed to push kernel to Kaggle'
      });
      throw new Error(pushResult.error);
    }

    this.taskStore.startTask(task.taskId, 'kaggle-backend');
    this.taskStore.appendLogs(task.taskId, [
      `Kernel successfully submitted to Kaggle. URL: ${pushResult.kernelUrl}`,
      `Starting background status monitor.`
    ]);

    // Start background polling daemon
    this.startBackgroundPoller(task.taskId, payload.kernelSlug);

    return {
      taskId: task.taskId,
      kernelSlug: payload.kernelSlug,
      status: 'running'
    };
  }

  private startBackgroundPoller(taskId: string, kernelSlug: string) {
    if (this.activePollers.has(taskId)) return;

    const poller = setInterval(async () => {
      try {
        const task = this.taskStore.getTask(taskId);
        if (!task || task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
          clearInterval(poller);
          this.activePollers.delete(taskId);
          return;
        }

        const statusRes = await this.client.getKernelStatus(kernelSlug);
        this.taskStore.appendLogs(taskId, [`Kaggle execution status: ${statusRes.status} (${statusRes.rawMessage || ''})`]);

        if (statusRes.status === 'complete') {
          clearInterval(poller);
          this.activePollers.delete(taskId);
          await this.finalizeKaggleRun(taskId, kernelSlug);
        } else if (statusRes.status === 'error') {
          clearInterval(poller);
          this.activePollers.delete(taskId);
          this.taskStore.failTask(taskId, {
            code: 'KAGGLE_RUN_FAILED',
            message: `Kaggle execution resulted in error: ${statusRes.rawMessage}`
          });
        } else if (statusRes.status === 'quotaExceeded') {
          clearInterval(poller);
          this.activePollers.delete(taskId);
          this.taskStore.failTask(taskId, {
            code: 'RESOURCE_QUOTA_EXCEEDED',
            message: 'Kaggle GPU quota limit exceeded during execution'
          });
        }
      } catch (err: any) {
        console.error(`Error polling Kaggle task ${taskId}:`, err);
      }
    }, this.pollIntervalMs);

    this.activePollers.set(taskId, poller);
  }

  private async finalizeKaggleRun(taskId: string, kernelSlug: string) {
    const outputDir = this.workDirBase ? path.join(this.workDirBase, taskId, 'outputs') : '';
    const downloadRes = await this.client.downloadKernelOutput(kernelSlug, outputDir);

    const resultSummary: KaggleTaskResult = {
      kernelSlug,
      status: 'complete',
      outputFiles: []
    };

    if (downloadRes.success && downloadRes.files && downloadRes.files.length > 0) {
      for (const item of downloadRes.files as any[]) {
        try {
          const fileName = typeof item === 'string' ? path.basename(item) : item.name;
          const content = typeof item === 'string' ? (fs.existsSync(item) ? fs.readFileSync(item) : '') : item.content || '';
          const type = fileName.endsWith('.json') ? 'json' : fileName.endsWith('.csv') ? 'csv' : 'log';
          const art = this.artifactStore.saveArtifact(taskId, fileName, content, type);

          resultSummary.outputFiles.push({
            fileName,
            sizeBytes: art.sizeBytes
          });

          // Check if result.json exists to populate metrics
          if (fileName === 'result.json' || fileName === 'metrics.json') {
            try {
              const text = Buffer.isBuffer(content) ? content.toString('utf-8') : (typeof content === 'string' ? content : '');
              resultSummary.metrics = JSON.parse(text);
            } catch {}
          }
        } catch (e) {
          console.error(`Failed to ingest artifact:`, e);
        }
      }
    }

    this.taskStore.completeTask(taskId, resultSummary);
    this.taskStore.appendLogs(taskId, [
      `Kaggle kernel run finalized successfully. Ingested ${resultSummary.outputFiles.length} artifacts.`
    ]);
  }
}
