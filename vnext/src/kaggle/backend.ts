import * as path from 'path';
import * as fs from 'fs';
import { KaggleClient } from './client';
import { IKaggleClient } from './kaggle-client.interface';
import { TaskStore } from '../storage/task-store';
import { ArtifactStore } from '../storage/artifact-store';
import { KaggleTaskPayload, KaggleTaskResult } from '../types/kaggle';
import { DurableTask } from '../types/task';

export interface KagglePollScheduler {
  schedule(taskId: string, kernelSlug: string, delayMs: number): Promise<void> | void;
}

type KaggleClientLike = IKaggleClient | KaggleClient;

export class KaggleBackend {
  private client: KaggleClientLike;
  private taskStore: TaskStore;
  private artifactStore: ArtifactStore;
  private workDirBase: string;
  private pollIntervalMs: number;
  private pollScheduler?: KagglePollScheduler;
  private activePollers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    taskStore: TaskStore,
    artifactStore: ArtifactStore,
    client?: KaggleClientLike,
    storageDir?: string,
    pollIntervalMs = 15000,
    pollScheduler?: KagglePollScheduler
  ) {
    this.taskStore = taskStore;
    this.artifactStore = artifactStore;
    this.client = client || new KaggleClient();
    this.pollIntervalMs = pollIntervalMs;
    this.pollScheduler = pollScheduler;

    if (storageDir && storageDir !== ':memory:') {
      this.workDirBase = path.join(storageDir, 'kaggle_runs');
      try {
        if (!fs.existsSync(this.workDirBase)) fs.mkdirSync(this.workDirBase, { recursive: true });
      } catch {}
    }
  }

  public getClient(): KaggleClientLike { return this.client; }

  public async submitKaggleTask(task: DurableTask<KaggleTaskPayload>): Promise<{ taskId: string; kernelSlug: string; status: string }> {
    const payload = task.payload;
    const taskWorkDir = this.workDirBase ? path.join(this.workDirBase, task.taskId) : '';
    this.taskStore.appendLogs(task.taskId, [
      `Initiating Kaggle kernel submission for slug: ${payload.kernelSlug}`,
      `GPU requested: ${!!payload.enableGpu}, Internet: ${payload.enableInternet !== false}`
    ]);

    const pushResult = (this.client as any).pushKernel.length === 1
      ? await (this.client as any).pushKernel(payload)
      : await (this.client as any).pushKernel(taskWorkDir || payload, payload);

    if (!pushResult.success) {
      this.taskStore.failTask(task.taskId, { code: pushResult.error?.includes('QUOTA') ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_PUSH_FAILED', message: pushResult.error || 'Failed to push kernel to Kaggle' });
      throw new Error(pushResult.error);
    }

    const actualSlug = pushResult.kernelSlug || payload.kernelSlug;
    payload.kernelSlug = actualSlug;
    this.taskStore.startTask(task.taskId, 'kaggle-backend');

    // Attach ExternalRunInfo to durable task
    const externalRun = {
      provider: 'kaggle' as const,
      kernelRef: actualSlug,
      versionNumber: pushResult.versionNumber || 'unknown',
      submittedAt: Date.now(),
      lastPolledAt: Date.now(),
      lastRemoteStatus: 'queued',
      reconciliationState: 'active' as const
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
    return { taskId: task.taskId, kernelSlug: actualSlug, status: 'running', versionNumber: pushResult.versionNumber } as any;
  }

  private async schedulePoll(taskId: string, kernelSlug: string): Promise<void> {
    if (this.pollScheduler) {
      await this.pollScheduler.schedule(taskId, kernelSlug, this.pollIntervalMs);
      return;
    }
    if (this.activePollers.has(taskId)) return;
    const timer = setTimeout(async () => {
      this.activePollers.delete(taskId);
      await this.pollKaggleTask(taskId, kernelSlug, true);
    }, this.pollIntervalMs);
    this.activePollers.set(taskId, timer);
  }

  public async pollKaggleTask(taskId: string, kernelSlug: string, reschedule = false): Promise<boolean> {
    return this.reconcileTask(taskId, reschedule);
  }

  /**
   * Reconciles an externally-submitted Kaggle task against the authoritative remote provider.
   * Never re-pushes or duplicates kernels on Kaggle.
   */
  public async reconcileTask(taskId: string, reschedule = false): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return false;

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
        ...(task.externalRun || { provider: 'kaggle' as const, submittedAt: task.createdAt }),
        kernelRef: kernelSlug,
        lastPolledAt: now,
        lastRemoteStatus: statusRes.status
      };

      this.taskStore.appendLogs(taskId, [`Kaggle execution status: ${statusRes.status} (${statusRes.rawMessage || ''})`]);

      if (statusRes.status === 'complete') {
        updatedExternalRun.reconciliationState = 'completed' as const;
        this.taskStore.setExternalRun(taskId, updatedExternalRun);
        await this.finalizeKaggleRun(taskId, kernelSlug);
        return false;
      }

      if (statusRes.status === 'error' || statusRes.status === 'quotaExceeded') {
        updatedExternalRun.reconciliationState = 'failed' as const;
        this.taskStore.setExternalRun(taskId, updatedExternalRun);
        this.taskStore.failTask(
          taskId,
          {
            code: statusRes.status === 'quotaExceeded' ? 'RESOURCE_QUOTA_EXCEEDED' : 'KAGGLE_RUN_FAILED',
            message: statusRes.status === 'quotaExceeded'
              ? 'Kaggle GPU quota limit exceeded during execution'
              : `Kaggle execution resulted in error: ${statusRes.rawMessage}`
          },
          { retryable: false }
        );
        return false;
      }

      if (statusRes.status === 'cancelled' || statusRes.status === 'cancelAcknowledged') {
        updatedExternalRun.reconciliationState = 'failed' as const;
        this.taskStore.setExternalRun(taskId, updatedExternalRun);
        this.taskStore.cancelTask(taskId, 'Kaggle execution cancelled remotely');
        return false;
      }

      // If running or queued, preserve active state and reschedule poll
      updatedExternalRun.reconciliationState = 'active' as const;
      this.taskStore.setExternalRun(taskId, updatedExternalRun);
      if (reschedule) await this.schedulePoll(taskId, kernelSlug);
      return true;
    } catch (err: any) {
      this.taskStore.appendLogs(taskId, [`Kaggle status poll failed: ${err.message || String(err)}`]);
      const updatedExternalRun = {
        ...(task.externalRun || { provider: 'kaggle' as const, submittedAt: task.createdAt }),
        kernelRef: kernelSlug,
        lastPolledAt: Date.now(),
        reconciliationState: 'pending' as const
      };
      this.taskStore.setExternalRun(taskId, updatedExternalRun);
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
              (resultSummary as any).result = parsed;
            } catch {}
          }
        } catch (err) { console.error('Failed to ingest Kaggle artifact:', err); }
      }
    }

    this.taskStore.completeTask(taskId, resultSummary);
    this.taskStore.appendLogs(taskId, [`Kaggle kernel run finalized successfully. Ingested ${resultSummary.outputFiles.length} artifacts.`]);
  }

  /**
   * Reconciles all non-terminal tasks associated with an external Kaggle run on system hydration/startup.
   */
  public async reconcileDanglingTasks(): Promise<{ reconciledCount: number }> {
    let count = 0;
    const nonTerminalTasks = this.taskStore.listTasks().filter(t =>
      ['queued', 'claimed', 'acknowledged', 'running'].includes(t.status) &&
      t.externalRun &&
      t.externalRun.provider === 'kaggle'
    );
    for (const task of nonTerminalTasks) {
      try {
        await this.reconcileTask(task.taskId, true);
        count++;
      } catch (err: any) {
        console.warn(`[KaggleBackend] Failed to reconcile dangling task ${task.taskId}:`, err.message);
      }
    }
    return { reconciledCount: count };
  }
}
