import * as crypto from 'crypto';
import * as path from 'path';
import { GatewayServer } from '../gateway/server';
import { redactObject } from '../security/redactor';
import { ScopeChecker } from '../security/scope-checker';
import { KaggleDatasetFileEntry, KaggleDatasetMetadata } from '../kaggle/kaggle-client.interface';
import {
  computeProjectFingerprint,
  parseNotebookCells,
  appendCellsToNotebook,
  parseKernelRef,
  validateNotebookDocument
} from '../kaggle/project-manager';
import {
  computeWorkspaceFingerprint,
  validateProjectManifest,
  validateWorkspaceRelativePath,
  buildKaggleUploadTree,
  DevSpaceProjectManifest,
  WorkspaceFileMetadata
} from '../kaggle/workspace-manager';

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
      const connected = this.gateway.connectionManager?.getConnectedAgents?.() || [];
      if (connected.length === 0) {
        return {
          taskId: result.taskId,
          status: result.status,
          backend: args.backend,
          capability: args.capability,
          waitingForEligibleDevice: true,
          reason: 'NO_ONLINE_DEVICE',
          isReplay: !!result.isReplay,
          message: 'Task queued, but no local agents are currently connected.'
        };
      }

      const eligible = connected.some((c: any) => c.capabilities?.includes(args.capability));
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
      isPrivate: typeof metadata.isPrivate === 'boolean' ? metadata.isPrivate : 'unknown',
      privacyKnown: typeof metadata.isPrivate === 'boolean',
      privacySource: metadata.isPrivate !== undefined ? 'kaggle_metadata' : 'unknown',
      persistedSourceVisibility: 'AVAILABLE',
      browserDraftVisibility: 'UNAVAILABLE',
      externalDraftConflictRisk: true,
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

    // P1-2: Browser draft safety guard
    if (args.acknowledgeUnobservedBrowserDraft !== true) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE',
          message: 'Kaggle browser Draft state is not observable via public API. Continuing will overwrite remote state with persisted source. Set acknowledgeUnobservedBrowserDraft: true to proceed.',
          kernelRef: ref
        })
      );
    }

    // Fetch CURRENT project source & metadata
    const current = await client.pullProject(owner, slug);
    const currentRawSource = current.source || '';
    const currentSourceSha256 = crypto.createHash('sha256').update(currentRawSource).digest('hex');

    // P0-4: Settings fail-closed guard (kernelType, language, isPrivate, enableGpu, enableInternet)
    const settings = args.settings || {};
    const currentKernelType = settings.kernelType || args.kernelType || current.metadata.kernelType;
    const currentLanguage = settings.language || args.language || current.metadata.language;
    const currentIsPrivate = settings.isPrivate !== undefined ? settings.isPrivate : (args.isPrivate !== undefined ? args.isPrivate : current.metadata.isPrivate);
    const currentEnableGpu = settings.enableGpu !== undefined ? settings.enableGpu : (args.enableGpu !== undefined ? args.enableGpu : current.metadata.enableGpu);
    const currentEnableInternet = settings.enableInternet !== undefined ? settings.enableInternet : (args.enableInternet !== undefined ? args.enableInternet : current.metadata.enableInternet);

    const unknownSettings: string[] = [];
    if (currentKernelType === undefined) unknownSettings.push('kernelType');
    if (currentLanguage === undefined) unknownSettings.push('language');
    if (currentIsPrivate === undefined || currentIsPrivate === null) unknownSettings.push('isPrivate');
    if (typeof currentEnableGpu !== 'boolean') unknownSettings.push('enableGpu');
    if (typeof currentEnableInternet !== 'boolean') unknownSettings.push('enableInternet');

    if (unknownSettings.length > 0) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_PROJECT_SETTINGS_UNKNOWN',
          message: `Authoritative settings for existing project are missing and cannot be guessed without explicit caller specification. Missing settings: ${unknownSettings.join(', ')}`,
          kernelRef: ref,
          unknownSettings
        })
      );
    }

    const currentFingerprint = computeProjectFingerprint({
      sourceSha256: currentSourceSha256,
      kernelType: currentKernelType,
      language: currentLanguage,
      isPrivate: currentIsPrivate,
      enableGpu: currentEnableGpu,
      enableInternet: currentEnableInternet,
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

    // Prepare and validate mutated source (P0-1 & P0-5)
    let newSource = '';
    if (currentKernelType === 'notebook') {
      if (mutation.type === 'append_notebook_cells') {
        if (!Array.isArray(mutation.cells) || mutation.cells.length === 0) {
          throw new Error('INVALID_MUTATION: cells array is required for append_notebook_cells');
        }
        if (!currentRawSource || currentRawSource.trim().length === 0) {
          throw new Error(
            JSON.stringify({
              error: 'KAGGLE_PROJECT_STATE_SUSPICIOUS',
              message: 'Project source is unexpectedly empty (0 bytes) for a notebook continuation. Aborting continue to prevent corrupting remote project.'
            })
          );
        }
        newSource = appendCellsToNotebook(currentRawSource, mutation.cells);
      } else if (mutation.type === 'replace_source') {
        newSource = mutation.source || mutation.code || '';
        const nbCheck = validateNotebookDocument(newSource);
        if (!nbCheck.valid) {
          throw new Error(`KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID: Replacement source for notebook project is not a valid Jupyter Notebook structure: ${nbCheck.error}`);
        }
      } else if (mutation.type === 'append_script') {
        throw new Error('KAGGLE_MUTATION_KERNEL_TYPE_MISMATCH: Cannot apply append_script to a notebook project. Use append_notebook_cells or replace_source with a valid notebook.');
      } else {
        throw new Error(`INVALID_MUTATION_TYPE: Unknown mutation type '${mutation.type}'`);
      }
    } else {
      // Current is script
      if (mutation.type === 'append_notebook_cells') {
        throw new Error('KAGGLE_MUTATION_KERNEL_TYPE_MISMATCH: Cannot apply append_notebook_cells to a script project. Use append_script or replace_source.');
      } else if (mutation.type === 'append_script') {
        const codeToAppend = mutation.code || mutation.source || '';
        newSource = currentRawSource + (currentRawSource.endsWith('\n') ? '\n' : '\n\n') + codeToAppend;
      } else if (mutation.type === 'replace_source') {
        newSource = mutation.source || mutation.code || '';
        if (!newSource || newSource.trim().length === 0) {
          throw new Error('INVALID_MUTATION: source is required for replace_source');
        }
      } else {
        throw new Error(`INVALID_MUTATION_TYPE: Unknown mutation type '${mutation.type}'`);
      }
    }

    const newSourceBytes = Buffer.byteLength(newSource, 'utf8');
    if (newSourceBytes > 1000000) {
      throw new Error(`KAGGLE_KERNEL_SOURCE_TOO_LARGE: Kernel source size (${newSourceBytes} bytes) exceeds the Kaggle 1 MiB limit. Please use USE_KAGGLE_WORKSPACE_MODE (kaggle_workspace_get, kaggle_workspace_file, kaggle_workspace_continue) for large persistent projects.`);
    }

    // Submit task reusing existing durable pipeline - preserve exact known settings
    const payload: any = {
      kernelSlug: ref,
      title: settings.title || current.metadata.title || slug,
      code: newSource,
      language: currentLanguage,
      kernelType: currentKernelType,
      isPrivate: currentIsPrivate,
      enableGpu: currentEnableGpu,
      enableInternet: currentEnableInternet
    };
    if (current.metadata.datasetDataSources !== undefined) payload.datasetDataSources = current.metadata.datasetDataSources;
    if (current.metadata.competitionDataSources !== undefined) payload.competitionDataSources = current.metadata.competitionDataSources;
    if (current.metadata.kernelDataSources !== undefined) payload.kernelDataSources = current.metadata.kernelDataSources;
    if (current.metadata.modelDataSources !== undefined) payload.modelDataSources = current.metadata.modelDataSources;
    if (current.metadata.machineShape !== undefined) payload.machineShape = current.metadata.machineShape;

    // 1. Save Pre-Write Snapshot
    const preWriteSnapshotId = await this.saveProjectSnapshot(
      ref,
      'pre-write-snapshot',
      currentRawSource,
      current.metadata,
      undefined,
      args.clientRequestId
    );

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

    // 2. Save Post-Write Snapshot
    const postWriteSnapshotId = await this.saveProjectSnapshot(
      ref,
      'post-write-snapshot',
      newSource,
      payload,
      result.taskId,
      args.clientRequestId
    );

    const task = this.gateway.taskStore.getTask(result.taskId);
    const actualSlug = task?.payload?.kernelSlug || ref;
    const actualRef = actualSlug.includes('/') ? actualSlug : `${owner}/${actualSlug}`;

    return {
      taskId: result.taskId,
      kernelRef: actualRef,
      status: result.status,
      createsNewKaggleVersion: true,
      createdVersionNumber: (result as any).versionNumber || task?.externalRun?.versionNumber || 'unknown',
      previousProjectFingerprint: currentFingerprint,
      submittedSourceSha256: crypto.createHash('sha256').update(newSource).digest('hex'),
      preWriteSnapshotId,
      postWriteSnapshotId,
      isReplay: !!result.isReplay,
      message: 'Kaggle persistent project updated and queued for execution. Query kaggle_status for execution progress.'
    };
  }

  public async handleKaggleProjectRestore(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.pullProject !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project restore is not supported by backend client');
    }

    const { owner, slug, ref } = parseKernelRef(args.kernelRef, client.getUsername());

    // Ownership protection: only owner can restore
    if (owner.toLowerCase() !== client.getUsername().toLowerCase()) {
      throw new Error(`KAGGLE_PROJECT_WRITE_FORBIDDEN: Cannot restore kernel owned by '${owner}' (authenticated user is '${client.getUsername()}')`);
    }

    if (!args.source) {
      throw new Error('INVALID_RESTORE_REQUEST: source is required for kaggle_project_restore');
    }
    if (!args.sourceSha256) {
      throw new Error('INVALID_RESTORE_REQUEST: sourceSha256 is required for kaggle_project_restore');
    }
    if (!args.reason) {
      throw new Error('INVALID_RESTORE_REQUEST: explicit restore reason is required');
    }

    const sourceBytes = Buffer.byteLength(args.source, 'utf8');
    if (sourceBytes > 1000000) {
      throw new Error(`KAGGLE_KERNEL_SOURCE_TOO_LARGE: Kernel source size (${sourceBytes} bytes) exceeds the Kaggle 1 MiB limit. Please use USE_KAGGLE_WORKSPACE_MODE (kaggle_workspace_get, kaggle_workspace_file, kaggle_workspace_continue) for large persistent projects.`);
    }

    // Verify incoming source SHA256 integrity
    const computedIncomingSha256 = crypto.createHash('sha256').update(args.source).digest('hex');
    if (computedIncomingSha256.toLowerCase() !== args.sourceSha256.toLowerCase()) {
      throw new Error(`RECOVERY_MASTER_SHA_MISMATCH: Computed source SHA-256 (${computedIncomingSha256}) does not match expected (${args.sourceSha256})`);
    }

    // Read current remote project
    const current = await client.pullProject(owner, slug);
    const currentRawSource = current.source || '';
    const currentSourceSha256 = crypto.createHash('sha256').update(currentRawSource).digest('hex');

    // P0-2: Default target kernel type to current remote kernel type
    const targetKernelType = args.kernelType || current.metadata.kernelType;

    // P0-2: Explicit kernel type change guard
    if (args.kernelType && current.metadata.kernelType && args.kernelType !== current.metadata.kernelType) {
      if (!args.allowKernelTypeChange || typeof args.kernelTypeChangeReason !== 'string' || args.kernelTypeChangeReason.trim().length === 0) {
        throw new Error(`KAGGLE_KERNEL_TYPE_CHANGE_FORBIDDEN: Changing kernelType from '${current.metadata.kernelType}' to '${args.kernelType}' requires allowKernelTypeChange: true and non-empty kernelTypeChangeReason.`);
      }
    }

    // Validate incoming source against TARGET kernel type using shared validator
    if (targetKernelType === 'notebook') {
      const nbCheck = validateNotebookDocument(args.source);
      if (!nbCheck.valid) {
        throw new Error(`INVALID_RESTORE_SOURCE: Provided source is not a valid Jupyter Notebook structure: ${nbCheck.error}`);
      }
    }

    // P0-4: Settings fail-closed guard for restore
    const settings = args.settings || {};
    const title = settings.title || current.metadata.title || slug;
    const isPrivate = settings.isPrivate !== undefined ? settings.isPrivate : current.metadata.isPrivate;
    const enableGpu = settings.enableGpu !== undefined ? settings.enableGpu : (args.enableGpu !== undefined ? args.enableGpu : current.metadata.enableGpu);
    const enableInternet = settings.enableInternet !== undefined ? settings.enableInternet : (args.enableInternet !== undefined ? args.enableInternet : current.metadata.enableInternet);
    const language = settings.language || args.language || current.metadata.language;

    const unknownSettings: string[] = [];
    if (isPrivate === undefined || isPrivate === null) unknownSettings.push('isPrivate');
    if (typeof enableGpu !== 'boolean') unknownSettings.push('enableGpu');
    if (typeof enableInternet !== 'boolean') unknownSettings.push('enableInternet');
    if (!language) unknownSettings.push('language');
    if (!targetKernelType) unknownSettings.push('kernelType');

    if (unknownSettings.length > 0) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_PROJECT_SETTINGS_UNKNOWN',
          message: `Authoritative settings for existing project restore are missing and cannot be guessed without explicit caller specification. Missing settings: ${unknownSettings.join(', ')}`,
          kernelRef: ref,
          unknownSettings
        })
      );
    }

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

    // Concurrency conflict check
    if (args.expectedCurrentFingerprint && args.expectedCurrentFingerprint !== currentFingerprint) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_PROJECT_CONFLICT',
          message: 'Project source or settings have changed since last inspection',
          expectedFingerprint: args.expectedCurrentFingerprint,
          currentFingerprint
        })
      );
    }

    // P2: Restore Prepare / Dry-Run UX
    if (args.dryRun === true) {
      return {
        dryRun: true,
        kernelRef: ref,
        currentProjectFingerprint: currentFingerprint,
        currentSourceSha256,
        currentKernelType: current.metadata.kernelType,
        targetKernelType,
        computedIncomingSourceSha256: computedIncomingSha256,
        sourceFormat: targetKernelType === 'notebook' ? 'ipynb' : 'script',
        sourceValidation: 'VALID',
        privacyValidation: {
          isPrivate,
          privacyKnown: typeof isPrivate === 'boolean',
          privacySource: 'kaggle_metadata'
        },
        kernelTypeChangeRequired: targetKernelType !== current.metadata.kernelType,
        writeAllowed: true,
        warnings: [
          'Kaggle browser draft cannot be observed via API; ensure local restore master is authoritative.'
        ],
        message: 'Dry run restore validation PASS. No mutation performed.'
      };
    }

    // P1-2: Browser draft safety guard for real restore
    if (args.acknowledgeUnobservedBrowserDraft !== true) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE',
          message: 'Kaggle browser Draft state is not observable via public API. Restoring will overwrite remote state. Set acknowledgeUnobservedBrowserDraft: true to proceed.',
          kernelRef: ref
        })
      );
    }

    // 1. Save Pre-Write Snapshot
    const preWriteSnapshotId = await this.saveProjectSnapshot(
      ref,
      'pre-write-snapshot',
      currentRawSource,
      current.metadata,
      undefined,
      args.clientRequestId
    );

    const payload: any = {
      kernelSlug: ref,
      title,
      code: args.source,
      language,
      kernelType: targetKernelType,
      isPrivate,
      enableGpu,
      enableInternet
    };
    const datasetDataSources = settings.datasetDataSources !== undefined ? settings.datasetDataSources : (args.datasetDataSources !== undefined ? args.datasetDataSources : current.metadata.datasetDataSources);
    const competitionDataSources = settings.competitionDataSources !== undefined ? settings.competitionDataSources : (args.competitionDataSources !== undefined ? args.competitionDataSources : current.metadata.competitionDataSources);
    const kernelDataSources = settings.kernelDataSources !== undefined ? settings.kernelDataSources : (args.kernelDataSources !== undefined ? args.kernelDataSources : current.metadata.kernelDataSources);
    const modelDataSources = settings.modelDataSources !== undefined ? settings.modelDataSources : (args.modelDataSources !== undefined ? args.modelDataSources : current.metadata.modelDataSources);
    const machineShape = settings.machineShape || args.machineShape || current.metadata.machineShape;

    if (datasetDataSources !== undefined) payload.datasetDataSources = datasetDataSources;
    if (competitionDataSources !== undefined) payload.competitionDataSources = competitionDataSources;
    if (kernelDataSources !== undefined) payload.kernelDataSources = kernelDataSources;
    if (modelDataSources !== undefined) payload.modelDataSources = modelDataSources;
    if (machineShape !== undefined) payload.machineShape = machineShape;

    // Route task submit
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

    // 2. Save Post-Write Snapshot
    const postWriteSnapshotId = await this.saveProjectSnapshot(
      ref,
      'post-write-snapshot',
      args.source,
      payload,
      result.taskId,
      args.clientRequestId
    );

    const task = this.gateway.taskStore.getTask(result.taskId);
    const actualSlug = task?.payload?.kernelSlug || ref;
    const actualRef = actualSlug.includes('/') ? actualSlug : `${owner}/${actualSlug}`;

    return {
      taskId: result.taskId,
      kernelRef: actualRef,
      status: result.status,
      createsNewKaggleVersion: true,
      createdVersionNumber: (result as any).versionNumber || task?.externalRun?.versionNumber || 'unknown',
      previousProjectFingerprint: currentFingerprint,
      restoredSourceSha256: computedIncomingSha256,
      preWriteSnapshotId,
      postWriteSnapshotId,
      reason: args.reason,
      isReplay: !!result.isReplay,
      message: 'Kaggle persistent project restored and queued for execution. Query kaggle_status for execution progress.'
    };
  }

  private async saveProjectSnapshot(
    kernelRef: string,
    snapshotType: 'pre-write-snapshot' | 'post-write-snapshot' | 'workspace-pre-write-snapshot' | 'workspace-post-write-snapshot',
    source: string,
    metadata: any,
    taskId?: string,
    clientRequestId?: string
  ): Promise<string> {
    try {
      const rawSource = source || '';
      const buf = Buffer.from(rawSource, 'utf-8');
      const isNotebook = metadata?.kernelType === 'notebook' || (metadata?.codeFile?.endsWith('.ipynb'));
      const safeRef = kernelRef.replace(/[^a-zA-Z0-9_\-]/g, '_');
      const fileName = `${safeRef}_${snapshotType}_${Date.now()}.${isNotebook ? 'ipynb' : 'py'}`;
      const artifactType = isNotebook ? 'notebook' : 'binary';
      const mimeType = isNotebook ? 'application/x-ipynb+json' : 'text/plain';

      const art = this.gateway.artifactStore.saveArtifact(
        taskId || 'project-snapshot',
        fileName,
        buf,
        artifactType as any,
        mimeType
      );

      if ((this.gateway as any).r2Storage && buf.byteLength <= 20971520) {
        try {
          await (this.gateway as any).r2Storage.putArtifact(art, buf);
        } catch (err) {
          console.warn('Failed to upload project snapshot to R2:', err);
        }
      }

      return art.id;
    } catch (err: any) {
      console.warn('Error creating project snapshot:', err.message);
      return '';
    }
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
    const connected = this.gateway.connectionManager?.getConnectedAgents?.() || [];

    // Group connected sockets by deviceId
    const connectedByDevice = new Map<string, any[]>();
    for (const agent of connected) {
      if (!agent || !agent.deviceId) continue;
      const list = connectedByDevice.get(agent.deviceId) || [];
      list.push(agent);
      connectedByDevice.set(agent.deviceId, list);
    }

    const deviceResults: any[] = [];
    const seenDeviceIds = new Set<string>();

    for (const d of devices) {
      seenDeviceIds.add(d.deviceId);
      const liveConns = connectedByDevice.get(d.deviceId) || [];
      const isOnline = liveConns.length > 0;
      const primaryLive = liveConns[0];
      const connectionCount = liveConns.length;
      const duplicateConnection = connectionCount > 1;

      // Authoritative capabilities for online device come from live WebSocket connection
      const capabilities = isOnline ? (primaryLive.capabilities || []) : (d.capabilities || []);

      const entry: any = {
        deviceId: d.deviceId,
        name: isOnline ? (primaryLive.name || d.name) : d.name,
        platform: d.platform,
        status: isOnline ? 'online' : 'offline',
        capabilities,
        lastHeartbeatAt: d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).toISOString() : undefined
      };

      if (isOnline) {
        entry.connectionCount = connectionCount;
        if (duplicateConnection) {
          entry.duplicateConnection = true;
        }
      }

      deviceResults.push(entry);
    }

    for (const [deviceId, liveConns] of connectedByDevice.entries()) {
      if (!seenDeviceIds.has(deviceId)) {
        const primaryLive = liveConns[0];
        const connectionCount = liveConns.length;
        const entry: any = {
          deviceId,
          name: primaryLive.name || deviceId,
          platform: primaryLive.platform || 'windows',
          status: 'online',
          capabilities: primaryLive.capabilities || [],
          connectionCount
        };
        if (connectionCount > 1) {
          entry.duplicateConnection = true;
        }
        deviceResults.push(entry);
      }
    }

    return {
      totalRegistered: devices.length,
      totalOnline: connectedByDevice.size,
      totalConnections: connected.length,
      devices: deviceResults
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

  // --- Large Project Workspace Handlers (Real Kaggle Dataset Control Plane) ---

  /**
   * Version-pins and validates an authoritative Kaggle Workspace revision.
   * Fails closed if manifest is corrupted, missing, version-mismatched, or file is absent.
   */
  public async loadWorkspaceRevision(owner: string, slug: string): Promise<{
    dataset: any;
    version: number;
    manifest: DevSpaceProjectManifest;
    datasetFiles: Array<{ name: string; totalBytes: number }>;
    resolvedStorage: Map<string, { storagePath: string; storageLayout: 'exact' | 'flattened' }>;
    workspaceFingerprint: string;
  }> {
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.getDataset !== 'function' || typeof client.listDatasetFiles !== 'function' || typeof client.downloadDatasetFile !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle Dataset control plane is not supported by backend client');
    }

    // 1. Get Dataset metadata
    const ds = await client.getDataset(owner, slug);
    const N = ds.currentVersionNumber || 1;

    // 2. List Dataset files explicitly pinned to version N
    const fileListing = await client.listDatasetFiles(owner, slug, N);
    const datasetFiles = fileListing.datasetFiles || [];
    const datasetFilesMap = new Map<string, number>(datasetFiles.map((f: any) => [f.name, f.totalBytes]));

    // 3. Download devspace-project.json explicitly pinned to version N
    let manifestDl: { content: Buffer; sizeBytes: number };
    try {
      manifestDl = await client.downloadDatasetFile(owner, slug, 'devspace-project.json', N);
    } catch (err: any) {
      throw new Error(`KAGGLE_WORKSPACE_MANIFEST_MISSING: Could not download devspace-project.json from ${owner}/${slug} version ${N}: ${err.message}`);
    }

    // 4. Parse and validate manifest schema
    let rawParsed: any;
    try {
      rawParsed = JSON.parse(manifestDl.content.toString('utf-8'));
    } catch (e: any) {
      throw new Error(`KAGGLE_WORKSPACE_MANIFEST_CORRUPTED: devspace-project.json is not valid JSON in ${owner}/${slug} version ${N}`);
    }
    const manifest = validateProjectManifest(rawParsed);

    // 5. Version guard: manifest.version must strictly equal dataset version N
    if (manifest.version !== N) {
      throw new Error(`KAGGLE_WORKSPACE_MANIFEST_VERSION_MISMATCH: Manifest version (${manifest.version}) does not match Kaggle dataset version (${N})`);
    }

    // 6. Identity guard: owner and slug must match requested project
    if (manifest.slug.toLowerCase() !== slug.toLowerCase()) {
      throw new Error(`KAGGLE_WORKSPACE_IDENTITY_MISMATCH: Manifest slug "${manifest.slug}" does not match requested slug "${slug}"`);
    }
    if (manifest.owner && manifest.owner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`KAGGLE_WORKSPACE_IDENTITY_MISMATCH: Manifest owner "${manifest.owner}" does not match requested owner "${owner}"`);
    }

    // 7. File presence guard & storage layout resolution
    const resolvedStorage = new Map<string, { storagePath: string; storageLayout: 'exact' | 'flattened' }>();

    for (const [filePath] of Object.entries(manifest.files || {})) {
      if (filePath === 'devspace-project.json' || filePath === 'devspace-execution-context.json') continue;
      if (datasetFilesMap.has(filePath)) {
        resolvedStorage.set(filePath, { storagePath: filePath, storageLayout: 'exact' });
      } else {
        const flatPath = filePath.replace(/[\/\\]/g, '_');
        if (datasetFilesMap.has(flatPath)) {
          resolvedStorage.set(filePath, { storagePath: flatPath, storageLayout: 'flattened' });
        } else {
          throw new Error(`KAGGLE_WORKSPACE_FILE_MISSING: Manifest file "${filePath}" is missing from Kaggle dataset version ${N}`);
        }
      }
    }

    // 8. Compute real workspace fingerprint
    const workspaceFingerprint = computeWorkspaceFingerprint(manifest);

    return {
      dataset: ds,
      version: N,
      manifest,
      datasetFiles,
      resolvedStorage,
      workspaceFingerprint
    };
  }

  public async handleKaggleWorkspaceGet(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client) {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle client unavailable');
    }

    const { owner, slug, ref } = parseKernelRef(args.project, client.getUsername());
    const ws = await this.loadWorkspaceRevision(owner, slug);

    const fileList = Object.keys(ws.manifest.files || {}).map(k => {
      const storageInfo = ws.resolvedStorage.get(k);
      return {
        path: k,
        size: ws.manifest.files[k].size,
        sha256: ws.manifest.files[k].sha256,
        storageLayout: storageInfo?.storageLayout || 'exact',
        storagePath: storageInfo?.storagePath || k,
        category: ws.manifest.files[k].category,
        description: ws.manifest.files[k].description
      };
    });

    return {
      project: ref,
      name: ws.manifest.name,
      slug: ws.manifest.slug,
      owner: ws.manifest.owner || owner,
      datasetVersion: ws.version,
      manifestVersion: ws.manifest.version,
      version: ws.version,
      type: ws.manifest.type,
      workspaceFingerprint: ws.workspaceFingerprint,
      entrypoint: ws.manifest.entrypoint,
      runnerKernelRef: ws.manifest.runnerKernelRef,
      archiveMaster: ws.manifest.archiveMaster,
      totalFiles: fileList.length,
      files: fileList,
      status: 'READY'
    };
  }

  public async handleKaggleWorkspaceFile(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client) {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle client unavailable');
    }

    const { owner, slug, ref } = parseKernelRef(args.project, client.getUsername());
    const rawPath = args.path;
    if (!rawPath) {
      throw new Error('INVALID_WORKSPACE_FILE_REQUEST: path is required');
    }
    const filePath = rawPath === 'devspace-project.json' ? 'devspace-project.json' : validateWorkspaceRelativePath(rawPath);

    const ws = await this.loadWorkspaceRevision(owner, slug);

    const fileMeta = ws.manifest.files?.[filePath];
    if (!fileMeta && filePath !== 'devspace-project.json') {
      throw new Error(`FILE_NOT_FOUND: Workspace file "${filePath}" not found in manifest of project ${ref}`);
    }

    // Determine physical storage path from resolved storage map
    const storageInfo = ws.resolvedStorage.get(filePath);
    const storagePath = storageInfo ? storageInfo.storagePath : filePath;

    let dl: { content: Buffer; sizeBytes: number };
    try {
      dl = await client.downloadDatasetFile(owner, slug, storagePath, ws.version);
    } catch (err: any) {
      throw new Error(`KAGGLE_WORKSPACE_FILE_DOWNLOAD_FAILED: Failed to download "${filePath}" (storage: "${storagePath}") from ${ref} version ${ws.version}: ${err.message}`);
    }

    const computedSha256 = crypto.createHash('sha256').update(dl.content).digest('hex');
    const computedSize = dl.content.length;

    // File SHA-256 and Size guards against manifest
    if (fileMeta) {
      if (fileMeta.sha256 && computedSha256.toLowerCase() !== fileMeta.sha256.toLowerCase()) {
        throw new Error(`KAGGLE_WORKSPACE_FILE_HASH_MISMATCH: Downloaded file "${filePath}" SHA-256 (${computedSha256}) does not match manifest SHA-256 (${fileMeta.sha256})`);
      }
      if (typeof fileMeta.size === 'number' && fileMeta.size > 0 && computedSize !== fileMeta.size) {
        throw new Error(`KAGGLE_WORKSPACE_FILE_SIZE_MISMATCH: Downloaded file "${filePath}" byte size (${computedSize}) does not match manifest byte size (${fileMeta.size})`);
      }
    }

    const rawText = dl.content.toString('utf-8');
    const offset = Math.max(0, args.offset || 0);
    const limit = Math.min(Math.max(1, args.limit || 50000), 100000);
    const chunk = rawText.slice(offset, offset + limit);
    const totalLength = rawText.length;
    const hasMore = offset + limit < totalLength;

    return {
      project: ref,
      datasetVersion: ws.version,
      workspaceFingerprint: ws.workspaceFingerprint,
      path: filePath,
      storagePath,
      storageLayout: storageInfo?.storageLayout || 'exact',
      content: chunk,
      offset,
      limit,
      totalLength,
      size: computedSize,
      hasMore,
      sha256: computedSha256
    };
  }

  /**
   * Reads a specific file from a Kaggle Dataset version with server-side actual byte SHA256 integrity verification.
   * Strictly READ ONLY.
   */
  public async handleKaggleDatasetFile(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:read', 'tasks:read', 'admin:*');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client || typeof client.listDatasetFiles !== 'function' || typeof client.downloadDatasetFile !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle dataset operations are not supported by backend client');
    }

    if (typeof args.datasetRef !== 'string' || !args.datasetRef.trim()) {
      throw new Error('INVALID_KAGGLE_DATASET_REF: datasetRef is required');
    }
    const trimmedRef = args.datasetRef.trim();
    const refParts = trimmedRef.split('/');
    if (refParts.length !== 2 || !refParts[0] || !refParts[1] || !/^[a-zA-Z0-9_\-.]+$/.test(refParts[0]) || !/^[a-zA-Z0-9_\-.]+$/.test(refParts[1])) {
      throw new Error(`INVALID_KAGGLE_DATASET_REF: Invalid dataset reference "${trimmedRef}". Must be in "owner/dataset-slug" format.`);
    }
    const owner = refParts[0];
    const slug = refParts[1];
    const canonicalRef = `${owner}/${slug}`;

    if (typeof args.relativePath !== 'string' || !args.relativePath.trim()) {
      throw new Error('INVALID_KAGGLE_DATASET_PATH: relativePath is required');
    }
    const rawPath = args.relativePath.trim();
    if (rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[a-zA-Z]:/.test(rawPath)) {
      throw new Error(`INVALID_KAGGLE_DATASET_PATH: Absolute paths are forbidden: "${rawPath}"`);
    }
    if (rawPath.includes('\\')) {
      throw new Error(`INVALID_KAGGLE_DATASET_PATH: Backslash path separators are forbidden: "${rawPath}"`);
    }
    const rawSegments = rawPath.split('/');
    for (const segment of rawSegments) {
      if (segment === '' || segment === '.' || segment === '..' || /^\.{2,}$/.test(segment)) {
        throw new Error(`INVALID_KAGGLE_DATASET_PATH: Path contains empty or traversal segments: "${rawPath}"`);
      }
    }
    const normalized = path.posix.normalize(rawPath);
    if (normalized !== rawPath) {
      throw new Error(`INVALID_KAGGLE_DATASET_PATH: Path is not in canonical normalized form: "${rawPath}"`);
    }
    const validPath = normalized;

    let expectedSha256: string | undefined = undefined;
    if (args.expectedSha256 !== undefined && args.expectedSha256 !== null) {
      if (typeof args.expectedSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(args.expectedSha256.trim())) {
        throw new Error(`INVALID_EXPECTED_SHA256: expectedSha256 must be a 64-character hexadecimal string`);
      }
      expectedSha256 = args.expectedSha256.trim();
    }

    let explicitVersion: number | undefined = undefined;
    if (args.datasetVersion !== undefined && args.datasetVersion !== null) {
      if (typeof args.datasetVersion !== 'number' || !Number.isInteger(args.datasetVersion) || args.datasetVersion < 1) {
        throw new Error('INVALID_KAGGLE_DATASET_VERSION: datasetVersion must be a positive integer');
      }
      explicitVersion = args.datasetVersion;
    }

    let maxBytes = 262144; // 256 KiB default
    if (args.maxBytes !== undefined && args.maxBytes !== null) {
      if (typeof args.maxBytes !== 'number' || !Number.isInteger(args.maxBytes) || args.maxBytes < 1 || args.maxBytes > 1048576) {
        throw new Error('INVALID_MAX_BYTES: maxBytes must be a positive integer between 1 and 1048576 bytes (1 MiB)');
      }
      maxBytes = args.maxBytes;
    }

    // 1. Resolve Dataset Version
    let resolvedVersion: number;
    let dsMeta: KaggleDatasetMetadata;
    try {
      dsMeta = await client.getDataset(owner, slug);
    } catch (err: any) {
      if (err.message?.includes('403') || err.message?.includes('401') || err.message?.includes('ACCESS_DENIED') || err.message?.includes('AUTH_') || err.message?.includes('Forbidden')) {
        throw new Error(`KAGGLE_DATASET_ACCESS_DENIED: Access denied for dataset ${canonicalRef}: ${err.message}`);
      }
      if (err.message?.includes('404') || err.message?.includes('NOT_FOUND') || err.message?.includes('not found')) {
        throw new Error(`KAGGLE_DATASET_NOT_FOUND: Dataset ${canonicalRef} not found: ${err.message}`);
      }
      throw new Error(`KAGGLE_DATASET_LOOKUP_FAILED: Failed to lookup dataset ${canonicalRef}: ${err.message}`);
    }

    if (!dsMeta || typeof dsMeta.currentVersionNumber !== 'number') {
      throw new Error(`KAGGLE_DATASET_NOT_FOUND: Dataset ${canonicalRef} not found`);
    }

    if (explicitVersion !== undefined) {
      if (explicitVersion > dsMeta.currentVersionNumber) {
        throw new Error(`KAGGLE_DATASET_VERSION_NOT_FOUND: Version ${explicitVersion} not found for dataset ${canonicalRef} (current version: ${dsMeta.currentVersionNumber})`);
      }
      resolvedVersion = explicitVersion;
    } else {
      resolvedVersion = dsMeta.currentVersionNumber;
    }

    // 2. File Existence & Safety Precheck via listDatasetFiles
    let fileListResult: { datasetFiles: KaggleDatasetFileEntry[] };
    try {
      fileListResult = await client.listDatasetFiles(owner, slug, resolvedVersion);
    } catch (err: any) {
      if (err.message?.includes('403') || err.message?.includes('401') || err.message?.includes('ACCESS_DENIED') || err.message?.includes('AUTH_') || err.message?.includes('Forbidden')) {
        throw new Error(`KAGGLE_DATASET_ACCESS_DENIED: Access denied listing files for ${canonicalRef} version ${resolvedVersion}: ${err.message}`);
      }
      if (err.message?.includes('404') || err.message?.includes('NOT_FOUND') || err.message?.includes('Version') || err.message?.includes('not found')) {
        if (explicitVersion !== undefined) {
          throw new Error(`KAGGLE_DATASET_VERSION_NOT_FOUND: Version ${resolvedVersion} of dataset ${canonicalRef} not found`);
        }
        throw new Error(`KAGGLE_DATASET_NOT_FOUND: Dataset ${canonicalRef} not found`);
      }
      throw new Error(`KAGGLE_DATASET_FILE_LIST_FAILED: Failed to list files for ${canonicalRef} version ${resolvedVersion}: ${err.message}`);
    }

    const exactFile = fileListResult.datasetFiles.find(f => f.name === validPath);
    if (!exactFile) {
      throw new Error(`KAGGLE_DATASET_FILE_NOT_FOUND: Exact file "${validPath}" not found in dataset ${canonicalRef} version ${resolvedVersion}`);
    }

    const MAX_FETCH_CEILING = 20971520; // 20 MiB safety ceiling
    if (exactFile.totalBytes > MAX_FETCH_CEILING) {
      throw new Error(`KAGGLE_DATASET_FILE_TOO_LARGE: File "${validPath}" size (${exactFile.totalBytes} bytes) exceeds maximum fetch ceiling of 20 MiB`);
    }

    // 3. Download File Content Pinned to Exact Version
    let dl: { content: Buffer; sizeBytes: number };
    try {
      dl = await client.downloadDatasetFile(owner, slug, validPath, resolvedVersion);
    } catch (err: any) {
      if (err.message?.includes('403') || err.message?.includes('401') || err.message?.includes('ACCESS_DENIED') || err.message?.includes('AUTH_') || err.message?.includes('Forbidden')) {
        throw new Error(`KAGGLE_DATASET_ACCESS_DENIED: Access denied when downloading "${validPath}" from ${canonicalRef} version ${resolvedVersion}: ${err.message}`);
      }
      throw new Error(`KAGGLE_DATASET_FILE_DOWNLOAD_FAILED: Failed to download "${validPath}" from ${canonicalRef} version ${resolvedVersion}: ${err.message}`);
    }

    // Post-download hard fetch ceiling check
    const actualBytes = dl.content;
    if (actualBytes.length > MAX_FETCH_CEILING) {
      throw new Error(`KAGGLE_DATASET_FILE_TOO_LARGE: Downloaded file "${validPath}" size (${actualBytes.length} bytes) exceeds maximum fetch ceiling of 20 MiB`);
    }

    // 4. Authoritative Actual Byte SHA256 Calculation
    const actualSha256 = crypto.createHash('sha256').update(actualBytes).digest('hex');
    const actualSize = actualBytes.length;

    let hashMatch: boolean | null = null;
    if (expectedSha256) {
      hashMatch = actualSha256.toLowerCase() === expectedSha256.toLowerCase();
    }

    // 5. Content-Type and Encoding Determination
    const ext = path.posix.extname(validPath).toLowerCase();
    const TEXT_MIME_TYPES: Record<string, string> = {
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.log': 'text/plain',
      '.md': 'text/markdown',
      '.csv': 'text/csv',
      '.tsv': 'text/tab-separated-values',
      '.yaml': 'application/yaml',
      '.yml': 'application/yaml',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.py': 'text/x-python',
      '.ts': 'text/typescript',
      '.js': 'text/javascript',
      '.ipynb': 'application/x-ipynb+json'
    };

    const BINARY_MIME_TYPES: Record<string, string> = {
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.parquet': 'application/x-parquet',
      '.pt': 'application/octet-stream',
      '.bin': 'application/octet-stream',
      '.pkl': 'application/octet-stream'
    };

    let isText = false;
    let contentType = 'application/octet-stream';

    if (TEXT_MIME_TYPES[ext]) {
      isText = true;
      contentType = TEXT_MIME_TYPES[ext];
    } else if (BINARY_MIME_TYPES[ext]) {
      isText = false;
      contentType = BINARY_MIME_TYPES[ext];
    } else {
      // Fail-closed: ANY unknown extension is classified as binary
      isText = false;
      contentType = 'application/octet-stream';
    }

    let encoding: string | null = null;
    let content: string | null = null;
    let isTruncated = false;
    let returnedBytes = 0;

    if (isText) {
      encoding = 'utf-8';
      if (actualBytes.length <= maxBytes) {
        content = actualBytes.toString('utf-8');
        isTruncated = false;
        returnedBytes = actualBytes.length;
      } else {
        isTruncated = true;
        let end = maxBytes;
        let i = end - 1;
        let seqLen = 1;
        while (i >= 0 && i >= end - 4) {
          const b = actualBytes[i];
          if ((b & 0x80) === 0) {
            seqLen = 1;
            break;
          } else if ((b & 0xe0) === 0xc0) {
            seqLen = 2;
            break;
          } else if ((b & 0xf0) === 0xe0) {
            seqLen = 3;
            break;
          } else if ((b & 0xf8) === 0xf0) {
            seqLen = 4;
            break;
          }
          i--;
        }
        if (seqLen > 1 && i >= 0) {
          const availableBytes = end - i;
          if (availableBytes < seqLen) {
            end = i;
          }
        }
        const sliceBuf = actualBytes.subarray(0, end);
        content = new TextDecoder('utf-8').decode(sliceBuf);
        returnedBytes = sliceBuf.length;
      }
    } else {
      encoding = null;
      content = null;
      isTruncated = false;
      returnedBytes = 0;
    }

    return {
      datasetRef: canonicalRef,
      datasetVersion: resolvedVersion,
      relativePath: validPath,
      size: actualSize,
      sha256: actualSha256,
      hashMatch,
      contentType,
      encoding,
      content,
      expectedSha256,
      isText,
      isTruncated,
      returnedBytes
    };
  }

  private validateAdditionalDatasetSources(sources?: any): string[] {
    if (sources === undefined || sources === null) {
      return [];
    }
    if (!Array.isArray(sources)) {
      throw new Error('INVALID_ADDITIONAL_DATASET_SOURCE: additionalDatasetDataSources must be an array of dataset references');
    }
    if (sources.length > 8) {
      throw new Error(`INVALID_ADDITIONAL_DATASET_SOURCE: Exceeded maximum allowed additionalDatasetDataSources (max 8, got ${sources.length})`);
    }
    const validated: string[] = [];
    const seen = new Set<string>();

    for (const item of sources) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(`INVALID_ADDITIONAL_DATASET_SOURCE: Dataset ref must be a non-empty string, got ${JSON.stringify(item)}`);
      }
      const trimmed = item.trim();
      if (trimmed.includes('\\') || trimmed.startsWith('/') || trimmed.endsWith('/')) {
        throw new Error(`INVALID_ADDITIONAL_DATASET_SOURCE: Invalid dataset reference "${trimmed}". Path format or backslash not allowed.`);
      }
      const parts = trimmed.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`INVALID_ADDITIONAL_DATASET_SOURCE: Invalid dataset reference "${trimmed}". Must be in "owner/dataset-slug" format.`);
      }
      const [owner, slug] = parts;
      if (!/^[a-zA-Z0-9_\-.]+$/.test(owner) || !/^[a-zA-Z0-9_\-.]+$/.test(slug) || owner === '.' || owner === '..' || slug === '.' || slug === '..') {
        throw new Error(`INVALID_ADDITIONAL_DATASET_SOURCE: Invalid dataset reference "${trimmed}". Contains invalid characters or traversal.`);
      }
      const canonicalRef = `${owner}/${slug}`;
      if (!seen.has(canonicalRef)) {
        seen.add(canonicalRef);
        validated.push(canonicalRef);
      }
    }
    return validated;
  }

  /**
   * Executes an existing canonical thin runner kernel without modifying its source code.
   * Pulls runner source before execution, verifies SHA-256 before & after observable submission, and mounts the workspace dataset.
   */
  public async runExistingWorkspaceRunner(params: {
    runnerKernelRef: string;
    workspaceDatasetRef: string;
    expectedVersion: number;
    expectedFingerprint: string;
    additionalDatasetDataSources?: string[];
    clientRequestId?: string;
    auth: McpCallerContext;
  }): Promise<{
    taskId: string;
    status: string;
    runnerKernelRef: string;
    runnerDatasetSources: string[];
    runnerSourceShaBefore: string;
    runnerSourceShaAfter: string;
  }> {
    const client = (this.gateway.kaggleBackend.getClient() as any);
    const { owner, slug, ref } = parseKernelRef(params.runnerKernelRef, client.getUsername());

    if (typeof client.pullProject !== 'function') {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: pullProject is required to execute existing runner');
    }

    // 1. Pull canonical runner source & metadata
    const pulled = await client.pullProject(owner, slug);
    if (!pulled || typeof pulled.source !== 'string') {
      throw new Error(`KAGGLE_RUNNER_NOT_FOUND: Could not pull canonical runner kernel "${params.runnerKernelRef}"`);
    }

    const runnerSource = pulled.source;
    const runnerMetadata = pulled.metadata || {};
    const runnerSourceShaBefore = crypto.createHash('sha256').update(runnerSource).digest('hex');

    // 2. Prepare payload preserving all canonical runner attributes and source code
    const existingDatasets: string[] = Array.isArray(runnerMetadata.datasetDataSources)
      ? runnerMetadata.datasetDataSources
      : [];
    const additionalDatasets: string[] = Array.isArray(params.additionalDatasetDataSources)
      ? params.additionalDatasetDataSources
      : [];
    const mergedDatasets = Array.from(new Set([
      ...existingDatasets,
      params.workspaceDatasetRef,
      ...additionalDatasets
    ]));

    const runnerPayload: any = {
      kernelSlug: ref,
      title: runnerMetadata.title || slug,
      code: runnerSource, // PRESERVE EXACT CANONICAL SOURCE
      language: runnerMetadata.language || 'python',
      kernelType: runnerMetadata.kernelType || 'notebook',
      isPrivate: runnerMetadata.isPrivate !== false,
      enableGpu: runnerMetadata.enableGpu !== undefined ? runnerMetadata.enableGpu : true,
      enableInternet: runnerMetadata.enableInternet !== false,
      datasetDataSources: mergedDatasets,
      kernelDataSources: runnerMetadata.kernelDataSources || [],
      competitionDataSources: runnerMetadata.competitionDataSources || [],
      modelDataSources: runnerMetadata.modelDataSources || runnerMetadata.modelSources || []
    };

    // 3. Submit runner execution task
    const taskResult = await this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: 'kaggle',
        capability: 'kaggle:run',
        payload: runnerPayload,
        clientRequestId: params.clientRequestId
      },
      params.auth.scopes,
      params.auth.subjectId
    );

    // 4. Verify runner source integrity on the observable submitted kernel version
    let runnerSourceShaAfter = runnerSourceShaBefore;
    if (!client.isMockMode) {
      let verified = false;
      let lastErr: string | undefined;

      // Poll up to 6 attempts (with 1.5s interval) to observe the submitted version on Kaggle
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const verifyPull = await client.pullProject(owner, slug);
          if (verifyPull && typeof verifyPull.source === 'string') {
            runnerSourceShaAfter = crypto.createHash('sha256').update(verifyPull.source).digest('hex');
            verified = true;
            break;
          }
        } catch (e: any) {
          lastErr = e.message;
        }
      }

      if (!verified) {
        throw new Error(`KAGGLE_RUNNER_VERIFICATION_TIMEOUT: Could not pull runner kernel after submission: ${lastErr || 'timeout'}`);
      }
    }

    if (runnerSourceShaBefore.toLowerCase() !== runnerSourceShaAfter.toLowerCase()) {
      throw new Error(`KAGGLE_RUNNER_SOURCE_INTEGRITY_FAILED: Runner source SHA-256 before submission (${runnerSourceShaBefore}) does not match after (${runnerSourceShaAfter})`);
    }

    return {
      taskId: taskResult.taskId,
      status: taskResult.status,
      runnerKernelRef: ref,
      runnerDatasetSources: mergedDatasets,
      runnerSourceShaBefore,
      runnerSourceShaAfter
    };
  }

  public async handleKaggleWorkspaceContinue(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
    const client = (this.gateway.kaggleBackend.getClient() as any);
    if (!client) {
      throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle client unavailable');
    }

    const { owner, slug, ref } = parseKernelRef(args.project, client.getUsername());
    if (owner.toLowerCase() !== client.getUsername().toLowerCase()) {
      throw new Error(`KAGGLE_PROJECT_WRITE_FORBIDDEN: Cannot mutate workspace owned by '${owner}' (authenticated user is '${client.getUsername()}')`);
    }

    if (!Array.isArray(args.changes) || args.changes.length === 0) {
      throw new Error('INVALID_MUTATION: changes array is required for kaggle_workspace_continue');
    }
    if (!args.reason) {
      throw new Error('INVALID_MUTATION: reason is required for kaggle_workspace_continue');
    }
    if (!args.expectedWorkspaceFingerprint) {
      throw new Error('INVALID_MUTATION: expectedWorkspaceFingerprint is required for optimistic concurrency protection');
    }

    // Validate additionalDatasetDataSources BEFORE any workspace mutation
    const rawAdditionalDatasets = args.additionalDatasetDataSources || args.additionalDatasets;
    const validatedAdditionalDatasets = this.validateAdditionalDatasetSources(rawAdditionalDatasets);

    // 1. Load REAL current dataset revision N
    const ws = await this.loadWorkspaceRevision(owner, slug);

    // 2. Concurrency Conflict Guard: verify expected fingerprint before doing ANY write or upload
    if (args.expectedWorkspaceFingerprint !== ws.workspaceFingerprint) {
      throw new Error(
        JSON.stringify({
          error: 'KAGGLE_WORKSPACE_CONFLICT',
          message: 'Workspace files have changed since last inspection',
          expectedFingerprint: args.expectedWorkspaceFingerprint,
          currentFingerprint: ws.workspaceFingerprint
        })
      );
    }

    // 3. Save Pre-Write Snapshot to storage
    const preWriteSnapshotId = await this.saveProjectSnapshot(
      ref,
      'workspace-pre-write-snapshot',
      JSON.stringify(ws.manifest, null, 2),
      ws.manifest,
      undefined,
      args.clientRequestId
    );

    // 4. Construct the complete Next Version (N + 1)
    const nextFilesMap: Record<string, WorkspaceFileMetadata> = { ...ws.manifest.files };
    const nextFileContents = new Map<string, Buffer>();
    const changesMap = new Map<string, any>();

    for (const change of args.changes) {
      if (!change.path || typeof change.content !== 'string') {
        throw new Error('INVALID_CHANGE_SPEC: Each change item must have string "path" and "content"');
      }
      const validPath = validateWorkspaceRelativePath(change.path);
      changesMap.set(validPath, change);
    }

    // For every unchanged file in current manifest: preserve exact content
    for (const existingPath of Object.keys(ws.manifest.files || {})) {
      if (existingPath === 'devspace-project.json' || existingPath === 'devspace-execution-context.json') continue;
      if (!changesMap.has(existingPath)) {
        const storageInfo = ws.resolvedStorage.get(existingPath);
        const storagePath = storageInfo ? storageInfo.storagePath : existingPath;
        let fileDl: { content: Buffer; sizeBytes: number };
        try {
          fileDl = await client.downloadDatasetFile(owner, slug, storagePath, ws.version);
        } catch (err: any) {
          throw new Error(`KAGGLE_WORKSPACE_FILE_DOWNLOAD_FAILED: Could not download unchanged file "${existingPath}" (storage: "${storagePath}") from ${ref} version ${ws.version}: ${err.message}`);
        }

        // Verify SHA and size of unchanged file against manifest
        const meta = ws.manifest.files[existingPath];
        if (meta) {
          const compSha = crypto.createHash('sha256').update(fileDl.content).digest('hex');
          if (meta.sha256 && compSha.toLowerCase() !== meta.sha256.toLowerCase()) {
            throw new Error(`KAGGLE_WORKSPACE_FILE_HASH_MISMATCH: Unchanged file "${existingPath}" SHA (${compSha}) does not match manifest (${meta.sha256})`);
          }
        }

        // Stage into next version with canonical POSIX relative path
        nextFileContents.set(existingPath, fileDl.content);
      }
    }

    // For every changed or added file:
    for (const [changePath, change] of changesMap.entries()) {
      if (change.expectedSha256 && nextFilesMap[changePath]) {
        if (nextFilesMap[changePath].sha256.toLowerCase() !== change.expectedSha256.toLowerCase()) {
          throw new Error(`FILE_INTEGRITY_CONFLICT: File "${changePath}" SHA-256 (${nextFilesMap[changePath].sha256}) does not match expected (${change.expectedSha256})`);
        }
      }

      const newBuf = Buffer.from(change.content, 'utf-8');
      const fileSha = crypto.createHash('sha256').update(newBuf).digest('hex');
      nextFileContents.set(changePath, newBuf);
      nextFilesMap[changePath] = {
        size: newBuf.length,
        sha256: fileSha,
        category: change.category || nextFilesMap[changePath]?.category,
        description: change.description || `Updated via DevSpace workspace mutation: ${args.reason}`
      };
    }

    delete nextFilesMap['devspace-project.json'];

    // Next Manifest version N + 1
    const nextVersion = ws.version + 1;
    const nextManifest: DevSpaceProjectManifest = {
      ...ws.manifest,
      version: nextVersion,
      files: nextFilesMap,
      entrypoint: args.experimentEntrypoint || ws.manifest.entrypoint,
      updatedAt: new Date().toISOString()
    };

    const nextFingerprint = computeWorkspaceFingerprint(nextManifest);

    // Include devspace-project.json and devspace-execution-context.json in upload contents
    const nextManifestText = JSON.stringify(nextManifest, null, 2);
    const nextManifestBuf = Buffer.from(nextManifestText, 'utf-8');
    nextFileContents.set('devspace-project.json', nextManifestBuf);

    const executionContext = {
      project: nextManifest.name,
      slug: nextManifest.slug,
      expectedDatasetVersion: nextVersion,
      expectedWorkspaceFingerprint: nextFingerprint,
      entrypoint: nextManifest.entrypoint,
      createdAt: new Date().toISOString()
    };
    const executionContextBuf = Buffer.from(JSON.stringify(executionContext, null, 2), 'utf-8');
    nextFileContents.set('devspace-execution-context.json', executionContextBuf);

    // 5. Upload blobs for ALL files
    const flatUploadedEntries: Array<{ relPath: string; token: string }> = [];
    for (const [filePath, buf] of nextFileContents.entries()) {
      const fileName = filePath.split('/').pop()!;
      const token = await client.uploadBlob(fileName, buf);
      flatUploadedEntries.push({ relPath: filePath, token });
    }

    // 6. Build hierarchical upload tree preserving directory structures
    const uploadTree = buildKaggleUploadTree(flatUploadedEntries);

    // 7. Create Dataset Version
    const datasetResult = await client.createDatasetVersion(
      slug,
      `DevSpace Workspace Version ${nextVersion}: ${args.reason}`,
      uploadTree.files,
      uploadTree.directories
    );
    if (!datasetResult.success && datasetResult.error) {
      throw new Error(`KAGGLE_DATASET_VERSION_FAILED: ${datasetResult.error}`);
    }

    // 8. Poll until Dataset is READY
    let isReady = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const stat = await client.getDatasetStatus(slug, owner);
      if (stat.isReady) {
        isReady = true;
        break;
      }
    }
    if (!isReady) {
      throw new Error('KAGGLE_WORKSPACE_TIMEOUT: Dataset version creation did not become READY in time');
    }

    // 9. Post-Write Verification before runner execution
    const verifiedWs = await this.loadWorkspaceRevision(owner, slug);
    if (verifiedWs.version !== nextVersion) {
      throw new Error(`KAGGLE_WORKSPACE_POST_WRITE_VERIFY_FAILED: Readback dataset version (${verifiedWs.version}) does not match expected next version (${nextVersion})`);
    }
    if (verifiedWs.manifest.version !== nextVersion) {
      throw new Error(`KAGGLE_WORKSPACE_POST_WRITE_VERIFY_FAILED: Readback manifest version (${verifiedWs.manifest.version}) does not match expected (${nextVersion})`);
    }
    if (verifiedWs.workspaceFingerprint !== nextFingerprint) {
      throw new Error(`KAGGLE_WORKSPACE_POST_WRITE_VERIFY_FAILED: Readback workspace fingerprint (${verifiedWs.workspaceFingerprint}) does not match expected next fingerprint (${nextFingerprint})`);
    }
    if (ws.manifest.archiveMaster) {
      if (!verifiedWs.manifest.archiveMaster || verifiedWs.manifest.archiveMaster.sha256.toLowerCase() !== ws.manifest.archiveMaster.sha256.toLowerCase()) {
        throw new Error('KAGGLE_WORKSPACE_POST_WRITE_VERIFY_FAILED: Archive master notebook integrity compromised during workspace update');
      }
    }

    // 10. Save Post-Write Snapshot
    const postWriteSnapshotId = await this.saveProjectSnapshot(
      ref,
      'workspace-post-write-snapshot',
      JSON.stringify(verifiedWs.manifest, null, 2),
      verifiedWs.manifest,
      undefined,
      args.clientRequestId
    );

    // 11. Execute Existing Canonical Runner (Zero synthetic stub, verified before & after SHA)
    const runnerKernelRef = args.runnerKernelRef || verifiedWs.manifest.runnerKernelRef || `${owner}/astor-tuneup-thin-runner`;

    const runnerExecution = await this.runExistingWorkspaceRunner({
      runnerKernelRef,
      workspaceDatasetRef: ref,
      expectedVersion: verifiedWs.version,
      expectedFingerprint: verifiedWs.workspaceFingerprint,
      additionalDatasetDataSources: validatedAdditionalDatasets,
      clientRequestId: args.clientRequestId,
      auth
    });

    return {
      taskId: runnerExecution.taskId,
      project: ref,
      workspaceVersion: verifiedWs.version,
      status: runnerExecution.status,
      previousWorkspaceFingerprint: ws.workspaceFingerprint,
      newWorkspaceFingerprint: verifiedWs.workspaceFingerprint,
      runnerKernelRef,
      runnerDatasetSources: runnerExecution.runnerDatasetSources,
      runnerSourceShaBefore: runnerExecution.runnerSourceShaBefore,
      runnerSourceShaAfter: runnerExecution.runnerSourceShaAfter,
      preWriteSnapshotId,
      postWriteSnapshotId,
      message: `Workspace updated to version ${verifiedWs.version} and canonical runner kernel queued for execution.`
    };
  }

  // ==========================================
  // LOCAL MULTI-PROJECT ROUTING HANDLERS
  // ==========================================

  private async submitLocalTaskAndWait(
    options: {
      capability: string;
      payload: any;
      clientRequestId?: string;
      idempotencyKey?: string;
    },
    auth: McpCallerContext,
    waitMs?: number
  ): Promise<any> {
    const defaultWaitMs = 8000;
    const boundedWaitMs = typeof waitMs === 'number' ? Math.min(Math.max(waitMs, 100), 15000) : defaultWaitMs;
    const pollIntervalMs = 100;

    // 1. Submit durable task via TaskRouter (preserves auth, scopes, audit, idempotency, killswitch)
    const submitResult = await this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: options.capability,
        payload: options.payload,
        clientRequestId: options.clientRequestId,
        idempotencyKey: options.idempotencyKey
      },
      auth.scopes,
      auth.subjectId
    );

    const taskId = submitResult.taskId;

    // 2. Check if already terminal (e.g. cached completed idempotent replay)
    let currentTask = this.gateway.taskStore.getTask(taskId);
    if (currentTask) {
      if (currentTask.status === 'succeeded') {
        return {
          taskId,
          status: 'succeeded',
          result: redactObject(currentTask.result),
          completedAt: currentTask.completedAt ? new Date(currentTask.completedAt).toISOString() : undefined,
          directResult: true
        };
      }
      if (currentTask.status === 'failed') {
        return {
          taskId,
          status: 'failed',
          error: currentTask.error,
          completedAt: currentTask.completedAt ? new Date(currentTask.completedAt).toISOString() : undefined,
          directResult: true
        };
      }
      if (currentTask.status === 'cancelled') {
        return {
          taskId,
          status: 'cancelled',
          error: currentTask.error,
          completedAt: currentTask.completedAt ? new Date(currentTask.completedAt).toISOString() : undefined,
          directResult: true
        };
      }
    }

    // 3. Preflight check: live connected agents (PR #5 source of truth)
    const connected = this.gateway.connectionManager?.getConnectedAgents?.() || [];
    if (connected.length === 0) {
      return {
        taskId,
        status: submitResult.status || 'queued',
        pending: true,
        waitingForEligibleDevice: true,
        reason: 'NO_ONLINE_DEVICE',
        isReplay: !!submitResult.isReplay,
        message: 'Task queued, but no local agents are currently connected.'
      };
    }

    const eligible = connected.some((c: any) => c.capabilities?.includes(options.capability));
    if (!eligible) {
      return {
        taskId,
        status: submitResult.status || 'queued',
        pending: true,
        waitingForEligibleDevice: true,
        reason: 'NO_ELIGIBLE_DEVICE_CAPABILITY',
        isReplay: !!submitResult.isReplay,
        message: `Task queued, but currently connected devices are not authorized for capability '${options.capability}'.`
      };
    }

    // 4. Bounded wait for eligible live agent execution
    const startTime = Date.now();
    while (Date.now() - startTime < boundedWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      currentTask = this.gateway.taskStore.getTask(taskId);
      if (!currentTask) break;

      if (currentTask.status === 'succeeded') {
        return {
          taskId,
          status: 'succeeded',
          result: redactObject(currentTask.result),
          completedAt: currentTask.completedAt ? new Date(currentTask.completedAt).toISOString() : undefined,
          directResult: true
        };
      }
      if (currentTask.status === 'failed') {
        return {
          taskId,
          status: 'failed',
          error: currentTask.error,
          completedAt: currentTask.completedAt ? new Date(currentTask.completedAt).toISOString() : undefined,
          directResult: true
        };
      }
      if (currentTask.status === 'cancelled') {
        return {
          taskId,
          status: 'cancelled',
          error: currentTask.error,
          completedAt: currentTask.completedAt ? new Date(currentTask.completedAt).toISOString() : undefined,
          directResult: true
        };
      }
    }

    // 5. Bounded wait timeout: return pending=true, directResult=false (do NOT cancel task)
    return {
      taskId,
      status: currentTask?.status || 'queued',
      pending: true,
      directResult: false,
      message: 'Task is still executing; query remote_task_status using this taskId.'
    };
  }

  public async handleLocalProjectList(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:list_projects',
        payload: args || {},
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalProjectStatus(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_project_status');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:project_status',
        payload: { projectId: args.projectId },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalReadFile(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId || !args?.relativePath) {
      throw new Error('INVALID_ARGUMENT: projectId and relativePath are required for local_read_file');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:read_file',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath,
          limit: args.limit
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalWriteFile(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:write', 'tasks:submit');
    if (!args?.projectId || !args?.relativePath) {
      throw new Error('INVALID_ARGUMENT: projectId and relativePath are required for local_write_file');
    }
    if (args?.content === undefined || args?.content === null) {
      throw new Error('INVALID_ARGUMENT: content is required for local_write_file');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:write_file',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath,
          content: args.content
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalPatchFile(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:write', 'tasks:submit');
    if (!args?.projectId || !args?.relativePath) {
      throw new Error('INVALID_ARGUMENT: projectId and relativePath are required for local_patch_file');
    }
    if (!args?.expectedSha256 || typeof args.expectedSha256 !== 'string') {
      throw new Error('INVALID_ARGUMENT: expectedSha256 is required for local_patch_file');
    }
    if (!Array.isArray(args?.patches) || args.patches.length === 0) {
      throw new Error('INVALID_ARGUMENT: patches array is required and must contain at least one patch object');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:patch_file',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath,
          expectedSha256: args.expectedSha256,
          patches: args.patches
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalListDirectory(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_list_directory');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:list_directory',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath || '.',
          maxEntries: args.maxEntries
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalFindFiles(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_find_files');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:find_files',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath || '.',
          pattern: args.pattern,
          name: args.name,
          recursive: args.recursive !== false,
          maxDepth: args.maxDepth,
          maxResults: args.maxResults,
          type: args.type || 'all'
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalSearchText(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId || !args?.query) {
      throw new Error('INVALID_ARGUMENT: projectId and query are required for local_search_text');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:search_text',
        payload: {
          projectId: args.projectId,
          query: args.query,
          relativePath: args.relativePath || '.',
          pattern: args.pattern,
          caseSensitive: args.caseSensitive,
          recursive: args.recursive !== false,
          maxDepth: args.maxDepth,
          maxResults: args.maxResults
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalFindRepositories(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_find_repositories');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:find_repositories',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath || '.',
          maxDepth: args.maxDepth
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalCreateDirectory(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:write', 'tasks:submit');
    if (!args?.projectId || !args?.relativePath) {
      throw new Error('INVALID_ARGUMENT: projectId and relativePath are required for local_create_directory');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:create_directory',
        payload: {
          projectId: args.projectId,
          relativePath: args.relativePath
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalGitStatus(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:read', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_git_status');
    }
    return this.submitLocalTaskAndWait(
      {
        capability: 'local:git_status',
        payload: {
          projectId: args.projectId,
          repoRelativePath: args?.repoRelativePath
        },
        clientRequestId: args?.clientRequestId
      },
      auth,
      args?.waitMs
    );
  }

  public async handleLocalRunTests(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:exec');
    this.requireScope(auth, 'local:test', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_run_tests');
    }
    return this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: 'local:run_tests',
        payload: {
          projectId: args.projectId,
          runnerId: args?.runnerId || 'npm',
          workingRelativePath: args?.workingRelativePath || '.'
        },
        clientRequestId: args?.clientRequestId
      },
      auth.scopes,
      auth.subjectId
    );
  }

  public async handleLocalBuildProject(args: any, caller?: McpCallerContext) {
    const auth = this.requireCaller(caller);
    this.requireScope(auth, 'local:exec');
    this.requireScope(auth, 'local:test', 'tasks:submit');
    if (!args?.projectId) {
      throw new Error('INVALID_ARGUMENT: projectId is required for local_build_project');
    }
    return this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: 'local:build_project',
        payload: {
          projectId: args.projectId,
          commandId: args?.commandId || 'npm',
          workingRelativePath: args?.workingRelativePath || '.'
        },
        clientRequestId: args?.clientRequestId
      },
      auth.scopes,
      auth.subjectId
    );
  }
}
