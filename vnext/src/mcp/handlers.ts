import * as crypto from 'crypto';
import { GatewayServer } from '../gateway/server';
import { redactObject } from '../security/redactor';
import { ScopeChecker } from '../security/scope-checker';
import {
  computeProjectFingerprint,
  parseNotebookCells,
  appendCellsToNotebook,
  parseKernelRef
} from '../kaggle/project-manager';

export interface McpCallerContext {
  scopes: string[];
  subjectId: string;
}

export class McpHandlers {
  constructor(private gateway: GatewayServer) {}

  private requireCaller(caller?: McpCallerContext): McpCallerContext {
    if (!caller) throw new Error('AUTH_CONTEXT_REQUIRED: authenticated caller context is required');
    return caller;
  }

  private requireScope(caller: McpCallerContext, ...accepted: string[]): void {
    if (!accepted.some(scope => ScopeChecker.hasScope(caller.scopes, scope))) {
      throw new Error(`AUTH_FORBIDDEN: Required one of scopes: ${accepted.join(', ')}`);
    }
  }

  public async handleRemoteTaskSubmit(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    const result = await this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: args.backend,
        capability: args.capability,
        payload: args.payload,
        priority: args.priority,
        clientRequestId: args.clientRequestId
      },
      auth.scopes,
      auth.subjectId
    );

    if (args.backend === 'local') {
      const devices = this.gateway.authManager.listDevices();
      const onlineDevices = devices.filter(d => d.status === 'online');
      if (onlineDevices.length > 0) {
        const eligible = onlineDevices.some(d => d.capabilities?.includes(args.capability));
        if (!eligible) {
          return {
            taskId: result.taskId,
            status: result.status,
            backend: args.backend,
            capability: args.capability,
            waitingForEligibleDevice: true,
            reason: 'NO_ELIGIBLE_DEVICE_CAPABILITY',
            isReplay: !!result.isReplay,
            message: `Task queued, but currently connected devices are not authorized for capability '${args.capability}'.`
          };
        }
      }
    }

    return {
      taskId: result.taskId,
      status: result.status,
      backend: args.backend,
      capability: args.capability,
      isReplay: !!result.isReplay,
      message: 'Task successfully submitted and queued in durable storage'
    };
  }

  public async handleRemoteTaskStatus(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'tasks:read');
    const task = this.gateway.taskStore.getTask(args.taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND: Task '${args.taskId}' does not exist`);

    return {
      taskId: task.taskId,
      backend: task.backend,
      capability: task.capability,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
      result: redactObject(task.result),
      error: task.error,
      artifactsCount: task.artifacts.length,
      logsCount: task.logs.length
    };
  }

  public async handleRemoteTaskLogs(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'tasks:read');
    const task = this.gateway.taskStore.getTask(args.taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND: Task '${args.taskId}' does not exist`);
    const limit = args.limit || 100;
    return {
      taskId: task.taskId,
      totalLines: task.logs.length,
      lines: task.logs.slice(-limit).map(line => redactObject(line))
    };
  }

  public async handleRemoteTaskArtifacts(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'artifacts:read', 'tasks:read');
    const artifacts = this.gateway.artifactStore.getTaskArtifacts(args.taskId);
    return {
      taskId: args.taskId,
      artifactsCount: artifacts.length,
      artifacts: artifacts.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        preview: a.preview,
        sha256: a.sha256
      }))
    };
  }

  public async handleRemoteTaskCancel(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'tasks:submit');
    const success = this.gateway.taskStore.cancelTask(args.taskId, args.reason || 'Cancelled by MCP caller');
    if (!success) throw new Error(`TASK_CANCEL_FAILED: Task '${args.taskId}' could not be cancelled`);
    return { taskId: args.taskId, status: 'cancelled' };
  }

  public async handleKaggleRun(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
    const result = await this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: 'kaggle',
        capability: 'kaggle:run',
        payload: {
          kernelSlug: args.kernelSlug,
          title: args.title,
          code: args.code,
          enableGpu: args.enableGpu,
          enableInternet: args.enableInternet,
          datasetDataSources: args.datasetDataSources
        },
        clientRequestId: args.clientRequestId
      },
      auth.scopes,
      auth.subjectId
    );

    const task = this.gateway.taskStore.getTask(result.taskId);
    const actualSlug = task?.payload?.kernelSlug || args.kernelSlug;
    const client = (this.gateway.kaggleBackend.getClient() as any);
    const username = client?.getUsername ? client.getUsername() : 'user';
    const kernelRef = actualSlug.includes('/') ? actualSlug : `${username}/${actualSlug}`;

    return {
      taskId: result.taskId,
      status: result.status,
      kernelSlug: actualSlug,
      kernelRef,
      message: 'Kaggle task submitted. Query kaggle_status for execution progress.'
    };
  }

  public async handleKaggleStatus(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    return this.handleRemoteTaskStatus(args, { ...auth, scopes: [...auth.scopes, 'tasks:read'] });
  }

  public async handleKaggleLogs(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    return this.handleRemoteTaskLogs(args, { ...auth, scopes: [...auth.scopes, 'tasks:read'] });
  }

  public async handleKaggleResult(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const elevatedRead = { ...auth, scopes: [...auth.scopes, 'tasks:read', 'artifacts:read'] };
    const status = await this.handleRemoteTaskStatus(args, elevatedRead);
    const artifacts = await this.handleRemoteTaskArtifacts(args, elevatedRead);
    return { taskId: args.taskId, status: status.status, result: status.result, error: status.error, artifacts: artifacts.artifacts };
  }

  public async handleKaggleProjectList(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.listProjects !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project list is not supported by backend client');
    }
    const projects = await client.listProjects(args || {});
    return { total: projects.length, projects };
  }

  public async handleKaggleProjectGet(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.pullProject !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project get is not supported by backend client');
    }
    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());
    const { metadata, source } = await client.pullProject(owner, slug);
    const sourceSha256 = crypto.createHash('sha256').update(source || '').digest('hex');
    const metadataSha256 = crypto.createHash('sha256').update(JSON.stringify(metadata || {})).digest('hex');
    const projectFingerprint = computeProjectFingerprint({
      sourceSha256,
      kernelType: metadata.kernelType,
      language: metadata.language,
      isPrivate: metadata.isPrivate,
      enableGpu: metadata.enableGpu,
      enableInternet: metadata.enableInternet,
      machineShape: metadata.machineShape,
      datasetSources: metadata.datasetDataSources,
      competitionSources: metadata.competitionDataSources,
      kernelSources: metadata.kernelDataSources,
      modelSources: metadata.modelDataSources
    });

    return {
      kernelRef: ref,
      title: metadata.title || slug,
      owner,
      slug,
      kernelType: metadata.kernelType || 'script',
      language: metadata.language || 'python',
      isPrivate: metadata.isPrivate !== false,
      enableGpu: !!metadata.enableGpu,
      enableInternet: metadata.enableInternet !== false,
      machineShape: metadata.machineShape,
      datasetSources: metadata.datasetDataSources || [],
      competitionSources: metadata.competitionDataSources || [],
      kernelSources: metadata.kernelDataSources || [],
      modelSources: metadata.modelDataSources || [],
      latestStatus: metadata.lastRunStatus,
      codeFile: metadata.codeFile,
      sourceSize: Buffer.byteLength(source || '', 'utf-8'),
      sourceSha256,
      metadataSha256,
      projectFingerprint
    };
  }

  public async handleKaggleProjectSource(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.pullProject !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project source is not supported by backend client');
    }
    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());
    const { metadata, source } = await client.pullProject(owner, slug, args.version);
    const rawSource = source || '';
    const sourceSha256 = crypto.createHash('sha256').update(rawSource).digest('hex');
    const projectFingerprint = computeProjectFingerprint({
      sourceSha256,
      kernelType: metadata.kernelType,
      language: metadata.language,
      isPrivate: metadata.isPrivate,
      enableGpu: metadata.enableGpu,
      enableInternet: metadata.enableInternet,
      machineShape: metadata.machineShape,
      datasetSources: metadata.datasetDataSources,
      competitionSources: metadata.competitionDataSources,
      kernelSources: metadata.kernelDataSources,
      modelSources: metadata.modelDataSources
    });

    const cellOptions = {
      includeCells: args.includeCells === true,
      cellOffset: args.cellOffset,
      cellLimit: args.cellLimit,
      includeCellSource: args.includeCellSource === true,
      maxCellSourceChars: args.maxCellSourceChars
    };
    const parsedCells = parseNotebookCells(rawSource, cellOptions);
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.min(Math.max(1, Number(args.limit) || 50000), 100000);
    const chunk = rawSource.substring(offset, offset + limit);
    const nextOffset = (offset + limit < rawSource.length) ? (offset + limit) : undefined;

    return {
      kernelRef: ref,
      requestedVersion: args.version,
      kernelType: metadata.kernelType || (parsedCells ? 'notebook' : 'script'),
      sourceFormat: parsedCells ? 'ipynb' : 'script',
      sourceSha256,
      projectFingerprint,
      totalLength: rawSource.length,
      offset,
      content: chunk,
      nextOffset,
      totalCells: parsedCells?.totalCells,
      cellOffset: cellOptions.includeCells ? (Number(args.cellOffset) || 0) : undefined,
      cellLimit: cellOptions.includeCells ? (Number(args.cellLimit) || 20) : undefined,
      nextCellOffset: parsedCells?.nextCellOffset,
      cells: parsedCells?.cells
    };
  }

  public async handleKaggleProjectFiles(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.getProjectOutputFiles !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project files is not supported by backend client');
    }
    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());
    const res = await client.getProjectOutputFiles(owner, slug);
    return {
      kernelRef: ref,
      filesCount: res.files.length,
      files: res.files
    };
  }

  public async handleKaggleProjectOutput(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());

    // Use single output file fetch when available
    if (typeof client.downloadSingleOutputFile === 'function') {
      const res = await client.downloadSingleOutputFile(owner, slug, args.filePattern);
      if (res.error?.includes('KAGGLE_OUTPUT_TOO_LARGE')) {
        throw new Error(res.error);
      }
      if (!res.file) {
        return {
          kernelRef: ref,
          totalFiles: res.totalFiles || 0,
          allFileNames: res.allFileNames || [],
          message: res.error || 'No output files available for this project'
        };
      }

      // Hard check > 20 MiB
      if (res.file.sizeBytes && res.file.sizeBytes > 20971520) {
        throw new Error(`KAGGLE_OUTPUT_TOO_LARGE: Output file "${res.file.name}" (${res.file.sizeBytes} bytes) exceeds the 20 MiB R2 single-object limit`);
      }

      const isTextFile = /\.(log|txt|json|csv|py|md|html|tsv|xml|yaml|yml)$/i.test(res.file.name);
      const isSmall = (res.file.sizeBytes || 0) < 262144; // < 256 KiB

      if (isSmall && isTextFile) {
        const textContent = typeof res.file.content === 'string'
          ? res.file.content
          : Buffer.isBuffer(res.file.content)
            ? res.file.content.toString('utf-8')
            : '';
        const maxBytes = Math.min(Number(args.maxBytes) || 262144, 262144);
        const isTruncated = textContent.length > maxBytes;
        return {
          kernelRef: ref,
          fileName: res.file.name,
          sizeBytes: res.file.sizeBytes || textContent.length,
          content: isTruncated ? textContent.substring(0, maxBytes) : textContent,
          isTruncated,
          totalFiles: res.totalFiles,
          allFileNames: res.allFileNames
        };
      }

      // Large file (>= 256 KiB) or binary file -> Route through ArtifactStore & R2
      const buf = Buffer.isBuffer(res.file.content)
        ? res.file.content
        : Buffer.from(typeof res.file.content === 'string' ? res.file.content : '');

      if (buf.byteLength > 20971520) {
        throw new Error(`KAGGLE_OUTPUT_TOO_LARGE: Output file "${res.file.name}" (${buf.byteLength} bytes) exceeds the 20 MiB R2 single-object limit`);
      }

      const ext = (res.file.name.includes('.') ? res.file.name.split('.').pop() || '' : '').toLowerCase();
      const mimeType = ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'zip' ? 'application/zip' : ext === 'ipynb' ? 'application/x-ipynb+json' : 'application/octet-stream';
      const artifactType: 'json' | 'csv' | 'binary' | 'image' | 'archive' | 'notebook' | 'log' = ext === 'json' ? 'json' : ext === 'csv' ? 'csv' : ext === 'png' || ext === 'jpg' || ext === 'jpeg' ? 'image' : ext === 'zip' || ext === 'tar' || ext === 'gz' ? 'archive' : ext === 'ipynb' ? 'notebook' : 'binary';
      const art = this.gateway.artifactStore.saveArtifact(
        'kaggle-project',
        res.file.name,
        buf,
        artifactType,
        mimeType
      );

      if ((this.gateway as any).r2Storage) {
        await (this.gateway as any).r2Storage.putArtifact(art, buf);
      }

      return {
        kernelRef: ref,
        fileName: res.file.name,
        sizeBytes: art.sizeBytes,
        sha256: art.sha256,
        artifactId: art.id,
        downloadUrl: `/api/artifacts/${encodeURIComponent(art.id)}`,
        totalFiles: res.totalFiles,
        allFileNames: res.allFileNames
      };
    }

    const outputRes = await client.downloadKernelOutput(slug, owner);
    if (!outputRes.success || !Array.isArray(outputRes.files) || outputRes.files.length === 0) {
      return {
        kernelRef: ref,
        totalFiles: 0,
        allFileNames: [],
        message: outputRes.error || 'No output files available for this project'
      };
    }

    const filePattern = (args.filePattern || '').toLowerCase();
    let targetFile = outputRes.files[0];
    if (filePattern) {
      const match = outputRes.files.find((f: any) => (f.name || '').toLowerCase().includes(filePattern));
      if (match) targetFile = match;
    }

    const content = targetFile.content ? (Buffer.isBuffer(targetFile.content) ? targetFile.content.toString('utf-8') : String(targetFile.content)) : '';
    const maxBytes = args.maxBytes || 262144;
    const isTruncated = content.length > maxBytes;
    const returnContent = isTruncated ? content.substring(0, maxBytes) : content;

    return {
      kernelRef: ref,
      fileName: targetFile.name,
      sizeBytes: targetFile.sizeBytes || content.length,
      content: returnContent,
      isTruncated,
      totalFiles: outputRes.files.length,
      allFileNames: outputRes.files.map((f: any) => f.name)
    };
  }

  public async handleKaggleProjectLogs(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());
    if (typeof client.getProjectLogs !== 'function') {
      return { kernelRef: ref, logs: [], available: false, message: 'KAGGLE_LOGS_NOT_AVAILABLE' };
    }
    const logsRes = await client.getProjectLogs(owner, slug);
    if (!logsRes.available || !Array.isArray(logsRes.logs) || logsRes.logs.length === 0) {
      return { kernelRef: ref, logs: [], available: false, message: 'KAGGLE_LOGS_NOT_AVAILABLE' };
    }
    const limit = Math.min(Math.max(1, Number(args.limit) || 100), 500);
    return {
      kernelRef: ref,
      available: true,
      totalLines: logsRes.logs.length,
      logs: logsRes.logs.slice(-limit).map((l: string) => redactObject(l))
    };
  }

  public async handleKaggleProjectContinue(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.pullProject !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project continue is not supported by backend client');
    }

    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());

    // Ownership protection: only owner can modify
    if (owner.toLowerCase() !== client.getUsername().toLowerCase()) {
      throw new Error(`KAGGLE_PROJECT_WRITE_FORBIDDEN: Cannot modify kernel owned by '${owner}' (authenticated user is '${client.getUsername()}')`);
    }

    // Fetch CURRENT project source & metadata
    const current = await client.pullProject(owner, slug);
    const currentRawSource = current.source || '';
    const currentSourceSha256 = crypto.createHash('sha256').update(currentRawSource).digest('hex');
    const currentFingerprint = computeProjectFingerprint({
      sourceSha256: currentSourceSha256,
      kernelType: current.metadata.kernelType,
      language: current.metadata.language,
      isPrivate: current.metadata.isPrivate,
      enableGpu: current.metadata.enableGpu,
      enableInternet: current.metadata.enableInternet,
      machineShape: current.metadata.machineShape,
      datasetSources: current.metadata.datasetDataSources,
      competitionSources: current.metadata.competitionDataSources,
      kernelSources: current.metadata.kernelDataSources,
      modelSources: current.metadata.modelDataSources
    });

    // Conflict check (optimistic concurrency guard)
    if (args.expectedProjectFingerprint && args.expectedProjectFingerprint !== currentFingerprint) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_PROJECT_CONFLICT',
          message: 'Project source or settings have changed since last inspection',
          expectedFingerprint: args.expectedProjectFingerprint,
          currentFingerprint
        })
      );
    }

    // Fail-Safe Suspicious State Guard: reject if state is inconsistent or corrupted
    const mutation = args.mutation || {};
    const isNotebookExpected = mutation.type === 'append_notebook_cells' || current.metadata.kernelType === 'notebook';
    if (isNotebookExpected) {
      if (!currentRawSource || currentRawSource.trim().length === 0) {
        throw new Error(
          JSON.stringify({
            error: 'KAGGLE_PROJECT_STATE_SUSPICIOUS',
            message: 'Project source is unexpectedly empty (0 bytes) for a notebook continuation. Aborting continue to prevent corrupting remote project.'
          })
        );
      }
      if (current.metadata.kernelType === 'script') {
        throw new Error(
          JSON.stringify({
            error: 'KAGGLE_PROJECT_STATE_SUSPICIOUS',
            message: `Project kernelType resolved to 'script' but notebook continuation was requested. Aborting continue to protect project.`
          })
        );
      }
      const parsed = parseNotebookCells(currentRawSource, { includeCells: false });
      if (!parsed || parsed.totalCells === 0) {
        throw new Error(
          JSON.stringify({
            error: 'KAGGLE_PROJECT_STATE_SUSPICIOUS',
            message: 'Project source is not a valid Jupyter Notebook structure (0 cells found). Aborting continue.'
          })
        );
      }
    } else if (mutation.type === 'append_script') {
      if (current.metadata.kernelType === 'notebook') {
        throw new Error(
          JSON.stringify({
            error: 'KAGGLE_PROJECT_STATE_SUSPICIOUS',
            message: `Project is a notebook but append_script was requested. Use append_notebook_cells instead.`
          })
        );
      }
    }

    // Prepare mutated source
    let newSource = '';
    if (mutation.type === 'append_notebook_cells') {
      if (!Array.isArray(mutation.cells) || mutation.cells.length === 0) {
        throw new Error('INVALID_MUTATION: cells array is required for append_notebook_cells');
      }
      newSource = appendCellsToNotebook(currentRawSource, mutation.cells);
    } else if (mutation.type === 'append_script') {
      const codeToAppend = mutation.code || mutation.source || '';
      newSource = currentRawSource + (currentRawSource.endsWith('\n') ? '\n' : '\n\n') + codeToAppend;
    } else if (mutation.type === 'replace_source') {
      newSource = mutation.source || mutation.code || '';
      if (!newSource) {
        throw new Error('INVALID_MUTATION: source is required for replace_source');
      }
    } else {
      throw new Error(`INVALID_MUTATION_TYPE: Unknown mutation type '${mutation.type}'`);
    }

    // Submit task reusing existing durable pipeline
    const payload: any = {
      kernelSlug: ref,
      title: current.metadata.title || slug,
      code: newSource,
      language: current.metadata.language || 'python',
      kernelType: current.metadata.kernelType || 'notebook',
      isPrivate: current.metadata.isPrivate !== false,
      enableGpu: !!current.metadata.enableGpu,
      enableInternet: current.metadata.enableInternet !== false,
      datasetDataSources: current.metadata.datasetDataSources,
      competitionDataSources: current.metadata.competitionDataSources,
      kernelDataSources: current.metadata.kernelDataSources
    };
    if (current.metadata.machineShape) payload.machineShape = current.metadata.machineShape;
    if (current.metadata.modelDataSources && current.metadata.modelDataSources.length > 0) payload.modelDataSources = current.metadata.modelDataSources;

    const result = await this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: 'kaggle',
        capability: 'kaggle:run',
        payload,
        clientRequestId: args.clientRequestId
      },
      auth.scopes,
      auth.subjectId
    );

    const task = this.gateway.taskStore.getTask(result.taskId);
    const actualSlug = task?.payload?.kernelSlug || ref;
    const actualRef = actualSlug.includes('/') ? actualSlug : `${owner}/${actualSlug}`;

    return {
      taskId: result.taskId,
      kernelRef: actualRef,
      status: result.status,
      previousProjectFingerprint: currentFingerprint,
      submittedSourceSha256: crypto.createHash('sha256').update(newSource).digest('hex'),
      isReplay: !!result.isReplay,
      message: 'Kaggle persistent project updated and queued for execution. Query kaggle_status for execution progress.'
    };
  }

  public async handleSwarmDispatch(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch');
    const result = this.gateway.swarmOrchestrator.dispatchTask({
      taskTitle: args.taskTitle || args.title || 'Chat Swarm task',
      prompt: args.prompt,
      roleRequired: args.roleRequired,
      contextFiles: args.contextFiles,
      timeoutMs: args.timeoutMs
    });
    return {
      taskId: result.taskId,
      assignedWorkerId: result.assignedWorkerId,
      message: result.assignedWorkerId ? 'Dispatched to active worker' : 'Queued for next available worker'
    };
  }

  public async handleSwarmStatus(caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch');
    const workers = this.gateway.swarmOrchestrator.listWorkers();
    return {
      totalWorkers: workers.length,
      idleWorkers: workers.filter(w => w.status === 'idle').length,
      busyWorkers: workers.filter(w => w.status === 'busy').length,
      workers
    };
  }

  public async handleChatSwarmDispatch(args: any, caller?: McpCallerContext) {
    return this.handleSwarmDispatch(args, caller);
  }

  public async handleChatSwarmStatus(_args?: any, caller?: McpCallerContext) {
    return this.handleSwarmStatus(caller);
  }

  public async handleChatSwarmClaim(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch');
    const worker = this.gateway.swarmOrchestrator.registerWorker(
      args.workerName || 'worker',
      args.role || 'default',
      args.capabilities || ['chat']
    );
    const task = this.gateway.swarmOrchestrator.claimNextTask(worker.workerId);
    return { ok: true, workerId: worker.workerId, workerToken: worker.workerId, task: task || null, status: task ? 'claimed' : 'idle' };
  }

  public async handleChatSwarmNext(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch');
    const workerId = args.workerToken;
    const worker = this.gateway.swarmOrchestrator.getWorker(workerId);
    if (!worker) throw new Error('WORKER_NOT_FOUND: invalid workerToken');
    const task = this.gateway.swarmOrchestrator.claimNextTask(workerId);
    return task ? { ok: true, status: 'task', task } : { ok: true, status: 'no_task', message: 'Waiting for swarm task' };
  }

  public async handleChatSwarmSubmit(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch');
    const workerId = args.workerToken;
    if (args.error) {
      const ok = this.gateway.swarmOrchestrator.failWorkerTask(workerId, args.taskId, { code: 'TASK_FAILED', message: args.error });
      if (!ok) throw new Error('TASK_SUBMIT_FAILED: worker/task ownership mismatch');
    } else {
      const ok = this.gateway.swarmOrchestrator.completeWorkerTask(workerId, args.taskId, args.result || { ok: true });
      if (!ok) throw new Error('TASK_SUBMIT_FAILED: worker/task ownership mismatch');
    }
    return { ok: true, taskId: args.taskId, status: 'submitted' };
  }

  public async handleChatSwarmCancel(args: any, caller?: McpCallerContext) {
    return this.handleRemoteTaskCancel(args, caller);
  }

  public async handleChatSwarmWakeBridge(_args?: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch');
    return { ok: true, wakeBridge: 'active', message: 'Browser wake bridge is operational' };
  }

  public async handleChatSwarmRuntimeStatus(caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'swarm:dispatch', 'local:read');
    const devices = this.gateway.authManager.listDevices();
    const connected = this.gateway.connectionManager.getConnectedAgents();
    return {
      ok: true,
      runtime: 'hybrid-desktop-cloud',
      totalRegisteredWorkers: devices.length,
      connectedWorkers: connected.length,
      workers: devices.map(d => ({
        workerId: d.deviceId,
        name: d.name,
        platform: d.platform,
        online: connected.some(c => c.deviceId === d.deviceId)
      }))
    };
  }

  public async handleDeviceStatus(caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'admin:*');
    const devices = this.gateway.authManager.listDevices();
    const connected = this.gateway.connectionManager.getConnectedAgents();
    return {
      totalRegistered: devices.length,
      totalOnline: connected.length,
      devices: devices.map(d => ({
        deviceId: d.deviceId,
        name: d.name,
        platform: d.platform,
        status: connected.some(c => c.deviceId === d.deviceId) ? 'online' : 'offline',
        capabilities: d.capabilities,
        lastHeartbeatAt: d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toISOString() : undefined
      }))
    };
  }

  public async handleKillSwitchTrigger(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'admin:killswitch');
    if (args.action === 'EMERGENCY_STOP') {
      await this.gateway.killSwitch.triggerGlobalEmergencyStop(args.reason);
    } else if (args.action === 'CLEAR_STOP') {
      await this.gateway.killSwitch.resetGlobalEmergencyStop();
    } else if (args.action === 'REVOKE_DEVICE' && args.deviceId) {
      await this.gateway.killSwitch.revokeDevice(args.deviceId, args.reason);
      this.gateway.authManager.revokeDevice(args.deviceId, args.reason);
    } else if (args.action === 'REVOKE_CLIENT' && args.clientId) {
      await this.gateway.killSwitch.revokeClient(args.clientId, args.reason);
    }
    return { status: 'OK', killSwitchState: this.gateway.killSwitch.getState() };
  }
}
