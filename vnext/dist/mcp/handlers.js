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
exports.McpHandlers = void 0;
const crypto = __importStar(require("crypto"));
const redactor_1 = require("../security/redactor");
const scope_checker_1 = require("../security/scope-checker");
const project_manager_1 = require("../kaggle/project-manager");
const workspace_manager_1 = require("../kaggle/workspace-manager");
class McpHandlers {
    gateway;
    constructor(gateway) {
        this.gateway = gateway;
    }
    requireCaller(caller) {
        if (!caller)
            throw new Error('AUTH_CONTEXT_REQUIRED: authenticated caller context is required');
        return caller;
    }
    requireScope(caller, ...accepted) {
        if (!accepted.some(scope => scope_checker_1.ScopeChecker.hasScope(caller.scopes, scope))) {
            throw new Error(`AUTH_FORBIDDEN: Required one of scopes: ${accepted.join(', ')}`);
        }
    }
    async handleRemoteTaskSubmit(args, caller) {
        const auth = this.requireCaller(caller);
        const result = await this.gateway.taskRouter.routeTaskSubmit({
            backend: args.backend,
            capability: args.capability,
            payload: args.payload,
            priority: args.priority,
            clientRequestId: args.clientRequestId
        }, auth.scopes, auth.subjectId);
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
    async handleRemoteTaskStatus(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'tasks:read');
        const task = this.gateway.taskStore.getTask(args.taskId);
        if (!task)
            throw new Error(`TASK_NOT_FOUND: Task '${args.taskId}' does not exist`);
        return {
            taskId: task.taskId,
            backend: task.backend,
            capability: task.capability,
            status: task.status,
            createdAt: new Date(task.createdAt).toISOString(),
            startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
            completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
            result: (0, redactor_1.redactObject)(task.result),
            error: task.error,
            artifactsCount: task.artifacts.length,
            logsCount: task.logs.length
        };
    }
    async handleRemoteTaskLogs(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'tasks:read');
        const task = this.gateway.taskStore.getTask(args.taskId);
        if (!task)
            throw new Error(`TASK_NOT_FOUND: Task '${args.taskId}' does not exist`);
        const limit = args.limit || 100;
        return {
            taskId: task.taskId,
            totalLines: task.logs.length,
            lines: task.logs.slice(-limit).map(line => (0, redactor_1.redactObject)(line))
        };
    }
    async handleRemoteTaskArtifacts(args, caller) {
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
    async handleRemoteTaskCancel(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'tasks:submit');
        const success = this.gateway.taskStore.cancelTask(args.taskId, args.reason || 'Cancelled by MCP caller');
        if (!success)
            throw new Error(`TASK_CANCEL_FAILED: Task '${args.taskId}' could not be cancelled`);
        return { taskId: args.taskId, status: 'cancelled' };
    }
    async handleKaggleRun(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
        const result = await this.gateway.taskRouter.routeTaskSubmit({
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
        }, auth.scopes, auth.subjectId);
        const task = this.gateway.taskStore.getTask(result.taskId);
        const actualSlug = task?.payload?.kernelSlug || args.kernelSlug;
        const client = this.gateway.kaggleBackend.getClient();
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
    async handleKaggleStatus(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        return this.handleRemoteTaskStatus(args, { ...auth, scopes: [...auth.scopes, 'tasks:read'] });
    }
    async handleKaggleLogs(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        return this.handleRemoteTaskLogs(args, { ...auth, scopes: [...auth.scopes, 'tasks:read'] });
    }
    async handleKaggleResult(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const elevatedRead = { ...auth, scopes: [...auth.scopes, 'tasks:read', 'artifacts:read'] };
        const status = await this.handleRemoteTaskStatus(args, elevatedRead);
        const artifacts = await this.handleRemoteTaskArtifacts(args, elevatedRead);
        return { taskId: args.taskId, status: status.status, result: status.result, error: status.error, artifacts: artifacts.artifacts };
    }
    async handleKaggleProjectList(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.listProjects !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project list is not supported by backend client');
        }
        const projects = await client.listProjects(args || {});
        return { total: projects.length, projects };
    }
    async handleKaggleProjectGet(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.pullProject !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project get is not supported by backend client');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
        const { metadata, source } = await client.pullProject(owner, slug);
        const sourceSha256 = crypto.createHash('sha256').update(source || '').digest('hex');
        const metadataSha256 = crypto.createHash('sha256').update(JSON.stringify(metadata || {})).digest('hex');
        const projectFingerprint = (0, project_manager_1.computeProjectFingerprint)({
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
    async handleKaggleProjectSource(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.pullProject !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project source is not supported by backend client');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
        const { metadata, source } = await client.pullProject(owner, slug, args.version);
        const rawSource = source || '';
        const sourceSha256 = crypto.createHash('sha256').update(rawSource).digest('hex');
        const projectFingerprint = (0, project_manager_1.computeProjectFingerprint)({
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
        const parsedCells = (0, project_manager_1.parseNotebookCells)(rawSource, cellOptions);
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
    async handleKaggleProjectFiles(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.getProjectOutputFiles !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project files is not supported by backend client');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
        const res = await client.getProjectOutputFiles(owner, slug);
        return {
            kernelRef: ref,
            filesCount: res.files.length,
            files: res.files
        };
    }
    async handleKaggleProjectOutput(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
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
            const artifactType = ext === 'json' ? 'json' : ext === 'csv' ? 'csv' : ext === 'png' || ext === 'jpg' || ext === 'jpeg' ? 'image' : ext === 'zip' || ext === 'tar' || ext === 'gz' ? 'archive' : ext === 'ipynb' ? 'notebook' : 'binary';
            const art = this.gateway.artifactStore.saveArtifact('kaggle-project', res.file.name, buf, artifactType, mimeType);
            if (this.gateway.r2Storage) {
                await this.gateway.r2Storage.putArtifact(art, buf);
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
            const match = outputRes.files.find((f) => (f.name || '').toLowerCase().includes(filePattern));
            if (match)
                targetFile = match;
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
            allFileNames: outputRes.files.map((f) => f.name)
        };
    }
    async handleKaggleProjectLogs(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
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
            logs: logsRes.logs.slice(-limit).map((l) => (0, redactor_1.redactObject)(l))
        };
    }
    async handleKaggleProjectContinue(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.pullProject !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project continue is not supported by backend client');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
        // Ownership protection: only owner can modify
        if (owner.toLowerCase() !== client.getUsername().toLowerCase()) {
            throw new Error(`KAGGLE_PROJECT_WRITE_FORBIDDEN: Cannot modify kernel owned by '${owner}' (authenticated user is '${client.getUsername()}')`);
        }
        // P1-2: Browser draft safety guard
        if (!args.acknowledgeUnobservedBrowserDraft) {
            throw new Error(JSON.stringify({
                error: 'KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE',
                message: 'Kaggle browser Draft state is not observable via public API. Continuing will overwrite remote state with persisted source. Set acknowledgeUnobservedBrowserDraft: true to proceed.',
                kernelRef: ref
            }));
        }
        // Fetch CURRENT project source & metadata
        const current = await client.pullProject(owner, slug);
        const currentRawSource = current.source || '';
        const currentSourceSha256 = crypto.createHash('sha256').update(currentRawSource).digest('hex');
        // P0-4: Privacy fail-closed guard
        if (current.metadata.isPrivate === undefined || current.metadata.isPrivate === null) {
            throw new Error('KAGGLE_PRIVACY_STATE_UNKNOWN: Current project privacy setting cannot be authoritatively determined. Cannot safely mutate existing project.');
        }
        const currentFingerprint = (0, project_manager_1.computeProjectFingerprint)({
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
            throw new Error(JSON.stringify({
                error: 'KAGGLE_PROJECT_CONFLICT',
                message: 'Project source or settings have changed since last inspection',
                expectedFingerprint: args.expectedProjectFingerprint,
                currentFingerprint
            }));
        }
        // Fail-Safe Suspicious State Guard: reject if state is inconsistent or corrupted
        const mutation = args.mutation || {};
        const currentKernelType = current.metadata.kernelType || 'notebook';
        // Prepare and validate mutated source (P0-1)
        let newSource = '';
        if (currentKernelType === 'notebook') {
            if (mutation.type === 'append_notebook_cells') {
                if (!Array.isArray(mutation.cells) || mutation.cells.length === 0) {
                    throw new Error('INVALID_MUTATION: cells array is required for append_notebook_cells');
                }
                if (!currentRawSource || currentRawSource.trim().length === 0) {
                    throw new Error(JSON.stringify({
                        error: 'KAGGLE_PROJECT_STATE_SUSPICIOUS',
                        message: 'Project source is unexpectedly empty (0 bytes) for a notebook continuation. Aborting continue to prevent corrupting remote project.'
                    }));
                }
                newSource = (0, project_manager_1.appendCellsToNotebook)(currentRawSource, mutation.cells);
            }
            else if (mutation.type === 'replace_source') {
                newSource = mutation.source || mutation.code || '';
                if (!newSource || newSource.trim().length === 0) {
                    throw new Error('INVALID_MUTATION: source is required for replace_source');
                }
                // Strict notebook validation for replace_source
                try {
                    const parsedJson = JSON.parse(newSource);
                    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson) || !Array.isArray(parsedJson.cells)) {
                        throw new Error('Root must be an object with cells array');
                    }
                    const check = (0, project_manager_1.parseNotebookCells)(newSource, { includeCells: false });
                    if (!check)
                        throw new Error('Notebook structure invalid');
                }
                catch (err) {
                    throw new Error(`KAGGLE_NOTEBOOK_SOURCE_FORMAT_INVALID: Replacement source for notebook project is not a valid Jupyter Notebook structure: ${err.message}`);
                }
            }
            else if (mutation.type === 'append_script') {
                throw new Error('KAGGLE_MUTATION_KERNEL_TYPE_MISMATCH: Cannot apply append_script to a notebook project. Use append_notebook_cells or replace_source with a valid notebook.');
            }
            else {
                throw new Error(`INVALID_MUTATION_TYPE: Unknown mutation type '${mutation.type}'`);
            }
        }
        else {
            // Current is script
            if (mutation.type === 'append_notebook_cells') {
                throw new Error('KAGGLE_MUTATION_KERNEL_TYPE_MISMATCH: Cannot apply append_notebook_cells to a script project. Use append_script or replace_source.');
            }
            else if (mutation.type === 'append_script') {
                const codeToAppend = mutation.code || mutation.source || '';
                newSource = currentRawSource + (currentRawSource.endsWith('\n') ? '\n' : '\n\n') + codeToAppend;
            }
            else if (mutation.type === 'replace_source') {
                newSource = mutation.source || mutation.code || '';
                if (!newSource || newSource.trim().length === 0) {
                    throw new Error('INVALID_MUTATION: source is required for replace_source');
                }
            }
            else {
                throw new Error(`INVALID_MUTATION_TYPE: Unknown mutation type '${mutation.type}'`);
            }
        }
        const newSourceBytes = Buffer.byteLength(newSource, 'utf8');
        if (newSourceBytes > 1000000) {
            throw new Error(`KAGGLE_KERNEL_SOURCE_TOO_LARGE: Kernel source size (${newSourceBytes} bytes) exceeds the Kaggle 1 MiB limit. Please use USE_KAGGLE_WORKSPACE_MODE (kaggle_workspace_get, kaggle_workspace_file, kaggle_workspace_continue) for large persistent projects.`);
        }
        // Submit task reusing existing durable pipeline
        const payload = {
            kernelSlug: ref,
            title: current.metadata.title || slug,
            code: newSource,
            language: current.metadata.language || 'python',
            kernelType: currentKernelType,
            isPrivate: current.metadata.isPrivate,
            enableGpu: !!current.metadata.enableGpu,
            enableInternet: current.metadata.enableInternet !== false,
            datasetDataSources: current.metadata.datasetDataSources,
            competitionDataSources: current.metadata.competitionDataSources,
            kernelDataSources: current.metadata.kernelDataSources
        };
        if (current.metadata.machineShape)
            payload.machineShape = current.metadata.machineShape;
        if (current.metadata.modelDataSources && current.metadata.modelDataSources.length > 0)
            payload.modelDataSources = current.metadata.modelDataSources;
        // 1. Save Pre-Write Snapshot
        const preWriteSnapshotId = await this.saveProjectSnapshot(ref, 'pre-write-snapshot', currentRawSource, current.metadata, undefined, args.clientRequestId);
        const result = await this.gateway.taskRouter.routeTaskSubmit({
            backend: 'kaggle',
            capability: 'kaggle:run',
            payload,
            clientRequestId: args.clientRequestId
        }, auth.scopes, auth.subjectId);
        // 2. Save Post-Write Snapshot
        const postWriteSnapshotId = await this.saveProjectSnapshot(ref, 'post-write-snapshot', newSource, payload, result.taskId, args.clientRequestId);
        const task = this.gateway.taskStore.getTask(result.taskId);
        const actualSlug = task?.payload?.kernelSlug || ref;
        const actualRef = actualSlug.includes('/') ? actualSlug : `${owner}/${actualSlug}`;
        return {
            taskId: result.taskId,
            kernelRef: actualRef,
            status: result.status,
            createsNewKaggleVersion: true,
            createdVersionNumber: result.versionNumber || task?.externalRun?.versionNumber || 'unknown',
            previousProjectFingerprint: currentFingerprint,
            submittedSourceSha256: crypto.createHash('sha256').update(newSource).digest('hex'),
            preWriteSnapshotId,
            postWriteSnapshotId,
            isReplay: !!result.isReplay,
            message: 'Kaggle persistent project updated and queued for execution. Query kaggle_status for execution progress.'
        };
    }
    async handleKaggleProjectRestore(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.pullProject !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle project restore is not supported by backend client');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.kernelRef, client.getUsername());
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
        // P0-4: Privacy fail-closed guard
        if (current.metadata.isPrivate === undefined || current.metadata.isPrivate === null) {
            throw new Error('KAGGLE_PRIVACY_STATE_UNKNOWN: Current project privacy setting cannot be authoritatively determined. Cannot safely restore project.');
        }
        // P0-2: Default target kernel type to current remote kernel type
        const targetKernelType = args.kernelType || current.metadata.kernelType || 'script';
        // P0-2: Explicit kernel type change guard
        if (args.kernelType && current.metadata.kernelType && args.kernelType !== current.metadata.kernelType) {
            if (!args.allowKernelTypeChange || typeof args.kernelTypeChangeReason !== 'string' || args.kernelTypeChangeReason.trim().length === 0) {
                throw new Error(`KAGGLE_KERNEL_TYPE_CHANGE_FORBIDDEN: Changing kernelType from '${current.metadata.kernelType}' to '${args.kernelType}' requires allowKernelTypeChange: true and non-empty kernelTypeChangeReason.`);
            }
        }
        // Validate incoming source against TARGET kernel type
        if (targetKernelType === 'notebook') {
            try {
                const parsedJson = JSON.parse(args.source);
                if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson) || !Array.isArray(parsedJson.cells)) {
                    throw new Error('Root must be an object with cells array');
                }
                const parsed = (0, project_manager_1.parseNotebookCells)(args.source, { includeCells: false });
                if (!parsed || parsed.totalCells === 0) {
                    throw new Error('0 cells found in notebook');
                }
            }
            catch (err) {
                throw new Error(`INVALID_RESTORE_SOURCE: Provided source is not a valid Jupyter Notebook structure: ${err.message}`);
            }
        }
        const currentFingerprint = (0, project_manager_1.computeProjectFingerprint)({
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
            throw new Error(JSON.stringify({
                error: 'KAGGLE_PROJECT_CONFLICT',
                message: 'Project source or settings have changed since last inspection',
                expectedFingerprint: args.expectedCurrentFingerprint,
                currentFingerprint
            }));
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
                    isPrivate: current.metadata.isPrivate,
                    privacyKnown: typeof current.metadata.isPrivate === 'boolean',
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
        if (!args.acknowledgeUnobservedBrowserDraft) {
            throw new Error(JSON.stringify({
                error: 'KAGGLE_BROWSER_DRAFT_STATE_UNOBSERVABLE',
                message: 'Kaggle browser Draft state is not observable via public API. Restoring will overwrite remote state. Set acknowledgeUnobservedBrowserDraft: true to proceed.',
                kernelRef: ref
            }));
        }
        // 1. Save Pre-Write Snapshot
        const preWriteSnapshotId = await this.saveProjectSnapshot(ref, 'pre-write-snapshot', currentRawSource, current.metadata, undefined, args.clientRequestId);
        // Build payload for durable submission
        const settings = args.settings || {};
        const title = settings.title || current.metadata.title || slug;
        const isPrivate = settings.isPrivate !== undefined ? settings.isPrivate : current.metadata.isPrivate;
        const enableGpu = settings.enableGpu !== undefined ? settings.enableGpu : (args.enableGpu !== undefined ? args.enableGpu : (targetKernelType === 'notebook'));
        const enableInternet = settings.enableInternet !== undefined ? settings.enableInternet : (args.enableInternet !== undefined ? args.enableInternet : true);
        const machineShape = settings.machineShape || args.machineShape || current.metadata.machineShape;
        const datasetDataSources = settings.datasetDataSources || args.datasetDataSources || current.metadata.datasetDataSources;
        const competitionDataSources = settings.competitionDataSources || args.competitionDataSources || current.metadata.competitionDataSources;
        const kernelDataSources = settings.kernelDataSources || args.kernelDataSources || current.metadata.kernelDataSources;
        const modelDataSources = settings.modelDataSources || args.modelDataSources || current.metadata.modelDataSources;
        const payload = {
            kernelSlug: ref,
            title,
            code: args.source,
            language: args.language || current.metadata.language || 'python',
            kernelType: targetKernelType,
            isPrivate,
            enableGpu,
            enableInternet,
            datasetDataSources,
            competitionDataSources,
            kernelDataSources,
            modelDataSources
        };
        if (machineShape)
            payload.machineShape = machineShape;
        // Route task submit
        const result = await this.gateway.taskRouter.routeTaskSubmit({
            backend: 'kaggle',
            capability: 'kaggle:run',
            payload,
            clientRequestId: args.clientRequestId
        }, auth.scopes, auth.subjectId);
        // 2. Save Post-Write Snapshot
        const postWriteSnapshotId = await this.saveProjectSnapshot(ref, 'post-write-snapshot', args.source, payload, result.taskId, args.clientRequestId);
        const task = this.gateway.taskStore.getTask(result.taskId);
        const actualSlug = task?.payload?.kernelSlug || ref;
        const actualRef = actualSlug.includes('/') ? actualSlug : `${owner}/${actualSlug}`;
        return {
            taskId: result.taskId,
            kernelRef: actualRef,
            status: result.status,
            createsNewKaggleVersion: true,
            createdVersionNumber: result.versionNumber || task?.externalRun?.versionNumber || 'unknown',
            previousProjectFingerprint: currentFingerprint,
            restoredSourceSha256: computedIncomingSha256,
            preWriteSnapshotId,
            postWriteSnapshotId,
            reason: args.reason,
            isReplay: !!result.isReplay,
            message: 'Kaggle persistent project restored and queued for execution. Query kaggle_status for execution progress.'
        };
    }
    async saveProjectSnapshot(kernelRef, snapshotType, source, metadata, taskId, clientRequestId) {
        try {
            const rawSource = source || '';
            const buf = Buffer.from(rawSource, 'utf-8');
            const isNotebook = metadata?.kernelType === 'notebook' || (metadata?.codeFile?.endsWith('.ipynb'));
            const safeRef = kernelRef.replace(/[^a-zA-Z0-9_\-]/g, '_');
            const fileName = `${safeRef}_${snapshotType}_${Date.now()}.${isNotebook ? 'ipynb' : 'py'}`;
            const artifactType = isNotebook ? 'notebook' : 'binary';
            const mimeType = isNotebook ? 'application/x-ipynb+json' : 'text/plain';
            const art = this.gateway.artifactStore.saveArtifact(taskId || 'project-snapshot', fileName, buf, artifactType, mimeType);
            if (this.gateway.r2Storage && buf.byteLength <= 20971520) {
                try {
                    await this.gateway.r2Storage.putArtifact(art, buf);
                }
                catch (err) {
                    console.warn('Failed to upload project snapshot to R2:', err);
                }
            }
            return art.id;
        }
        catch (err) {
            console.warn('Error creating project snapshot:', err.message);
            return '';
        }
    }
    async handleSwarmDispatch(args, caller) {
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
    async handleSwarmStatus(caller) {
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
    async handleChatSwarmDispatch(args, caller) {
        return this.handleSwarmDispatch(args, caller);
    }
    async handleChatSwarmStatus(_args, caller) {
        return this.handleSwarmStatus(caller);
    }
    async handleChatSwarmClaim(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'swarm:dispatch');
        const worker = this.gateway.swarmOrchestrator.registerWorker(args.workerName || 'worker', args.role || 'default', args.capabilities || ['chat']);
        const task = this.gateway.swarmOrchestrator.claimNextTask(worker.workerId);
        return { ok: true, workerId: worker.workerId, workerToken: worker.workerId, task: task || null, status: task ? 'claimed' : 'idle' };
    }
    async handleChatSwarmNext(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'swarm:dispatch');
        const workerId = args.workerToken;
        const worker = this.gateway.swarmOrchestrator.getWorker(workerId);
        if (!worker)
            throw new Error('WORKER_NOT_FOUND: invalid workerToken');
        const task = this.gateway.swarmOrchestrator.claimNextTask(workerId);
        return task ? { ok: true, status: 'task', task } : { ok: true, status: 'no_task', message: 'Waiting for swarm task' };
    }
    async handleChatSwarmSubmit(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'swarm:dispatch');
        const workerId = args.workerToken;
        if (args.error) {
            const ok = this.gateway.swarmOrchestrator.failWorkerTask(workerId, args.taskId, { code: 'TASK_FAILED', message: args.error });
            if (!ok)
                throw new Error('TASK_SUBMIT_FAILED: worker/task ownership mismatch');
        }
        else {
            const ok = this.gateway.swarmOrchestrator.completeWorkerTask(workerId, args.taskId, args.result || { ok: true });
            if (!ok)
                throw new Error('TASK_SUBMIT_FAILED: worker/task ownership mismatch');
        }
        return { ok: true, taskId: args.taskId, status: 'submitted' };
    }
    async handleChatSwarmCancel(args, caller) {
        return this.handleRemoteTaskCancel(args, caller);
    }
    async handleChatSwarmWakeBridge(_args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'swarm:dispatch');
        return { ok: true, wakeBridge: 'active', message: 'Browser wake bridge is operational' };
    }
    async handleChatSwarmRuntimeStatus(caller) {
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
    async handleDeviceStatus(caller) {
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
    async handleKillSwitchTrigger(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'admin:killswitch');
        if (args.action === 'EMERGENCY_STOP') {
            await this.gateway.killSwitch.triggerGlobalEmergencyStop(args.reason);
        }
        else if (args.action === 'CLEAR_STOP') {
            await this.gateway.killSwitch.resetGlobalEmergencyStop();
        }
        else if (args.action === 'REVOKE_DEVICE' && args.deviceId) {
            await this.gateway.killSwitch.revokeDevice(args.deviceId, args.reason);
            this.gateway.authManager.revokeDevice(args.deviceId, args.reason);
        }
        else if (args.action === 'REVOKE_CLIENT' && args.clientId) {
            await this.gateway.killSwitch.revokeClient(args.clientId, args.reason);
        }
        return { status: 'OK', killSwitchState: this.gateway.killSwitch.getState() };
    }
    // --- Large Project Workspace Handlers (Real Kaggle Dataset Control Plane) ---
    /**
     * Version-pins and validates an authoritative Kaggle Workspace revision.
     * Fails closed if manifest is corrupted, missing, version-mismatched, or file is absent.
     */
    async loadWorkspaceRevision(owner, slug) {
        const client = this.gateway.kaggleBackend.getClient();
        if (!client || typeof client.getDataset !== 'function' || typeof client.listDatasetFiles !== 'function' || typeof client.downloadDatasetFile !== 'function') {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle Dataset control plane is not supported by backend client');
        }
        // 1. Get Dataset metadata
        const ds = await client.getDataset(owner, slug);
        const N = ds.currentVersionNumber || 1;
        // 2. List Dataset files explicitly pinned to version N
        const fileListing = await client.listDatasetFiles(owner, slug, N);
        const datasetFiles = fileListing.datasetFiles || [];
        const datasetFilesMap = new Map(datasetFiles.map((f) => [f.name, f.totalBytes]));
        // 3. Download devspace-project.json explicitly pinned to version N
        let manifestDl;
        try {
            manifestDl = await client.downloadDatasetFile(owner, slug, 'devspace-project.json', N);
        }
        catch (err) {
            throw new Error(`KAGGLE_WORKSPACE_MANIFEST_MISSING: Could not download devspace-project.json from ${owner}/${slug} version ${N}: ${err.message}`);
        }
        // 4. Parse and validate manifest schema
        let rawParsed;
        try {
            rawParsed = JSON.parse(manifestDl.content.toString('utf-8'));
        }
        catch (e) {
            throw new Error(`KAGGLE_WORKSPACE_MANIFEST_CORRUPTED: devspace-project.json is not valid JSON in ${owner}/${slug} version ${N}`);
        }
        const manifest = (0, workspace_manager_1.validateProjectManifest)(rawParsed);
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
        const resolvedStorage = new Map();
        for (const [filePath] of Object.entries(manifest.files || {})) {
            if (filePath === 'devspace-project.json' || filePath === 'devspace-execution-context.json')
                continue;
            if (datasetFilesMap.has(filePath)) {
                resolvedStorage.set(filePath, { storagePath: filePath, storageLayout: 'exact' });
            }
            else {
                const flatPath = filePath.replace(/[\/\\]/g, '_');
                if (datasetFilesMap.has(flatPath)) {
                    resolvedStorage.set(filePath, { storagePath: flatPath, storageLayout: 'flattened' });
                }
                else {
                    throw new Error(`KAGGLE_WORKSPACE_FILE_MISSING: Manifest file "${filePath}" is missing from Kaggle dataset version ${N}`);
                }
            }
        }
        // 8. Compute real workspace fingerprint
        const workspaceFingerprint = (0, workspace_manager_1.computeWorkspaceFingerprint)(manifest);
        return {
            dataset: ds,
            version: N,
            manifest,
            datasetFiles,
            resolvedStorage,
            workspaceFingerprint
        };
    }
    async handleKaggleWorkspaceGet(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client) {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle client unavailable');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.project, client.getUsername());
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
    async handleKaggleWorkspaceFile(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:read', 'tasks:read');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client) {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle client unavailable');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.project, client.getUsername());
        const rawPath = args.path;
        if (!rawPath) {
            throw new Error('INVALID_WORKSPACE_FILE_REQUEST: path is required');
        }
        const filePath = rawPath === 'devspace-project.json' ? 'devspace-project.json' : (0, workspace_manager_1.validateWorkspaceRelativePath)(rawPath);
        const ws = await this.loadWorkspaceRevision(owner, slug);
        const fileMeta = ws.manifest.files?.[filePath];
        if (!fileMeta && filePath !== 'devspace-project.json') {
            throw new Error(`FILE_NOT_FOUND: Workspace file "${filePath}" not found in manifest of project ${ref}`);
        }
        // Determine physical storage path from resolved storage map
        const storageInfo = ws.resolvedStorage.get(filePath);
        const storagePath = storageInfo ? storageInfo.storagePath : filePath;
        let dl;
        try {
            dl = await client.downloadDatasetFile(owner, slug, storagePath, ws.version);
        }
        catch (err) {
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
     * Executes an existing canonical thin runner kernel without modifying its source code.
     * Pulls runner source before execution, verifies SHA-256 before & after observable submission, and mounts the workspace dataset.
     */
    async runExistingWorkspaceRunner(params) {
        const client = this.gateway.kaggleBackend.getClient();
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(params.runnerKernelRef, client.getUsername());
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
        const existingDatasets = Array.isArray(runnerMetadata.datasetDataSources)
            ? runnerMetadata.datasetDataSources
            : [];
        const mergedDatasets = Array.from(new Set([...existingDatasets, params.workspaceDatasetRef]));
        const runnerPayload = {
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
        const taskResult = await this.gateway.taskRouter.routeTaskSubmit({
            backend: 'kaggle',
            capability: 'kaggle:run',
            payload: runnerPayload,
            clientRequestId: params.clientRequestId
        }, params.auth.scopes, params.auth.subjectId);
        // 4. Verify runner source integrity on the observable submitted kernel version
        let runnerSourceShaAfter = runnerSourceShaBefore;
        if (!client.isMockMode) {
            let verified = false;
            let lastErr;
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
                }
                catch (e) {
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
            runnerSourceShaBefore,
            runnerSourceShaAfter
        };
    }
    async handleKaggleWorkspaceContinue(args, caller) {
        const auth = this.requireCaller(caller);
        this.requireScope(auth, 'kaggle:submit', 'tasks:submit');
        const client = this.gateway.kaggleBackend.getClient();
        if (!client) {
            throw new Error('KAGGLE_CLIENT_UNAVAILABLE: Kaggle client unavailable');
        }
        const { owner, slug, ref } = (0, project_manager_1.parseKernelRef)(args.project, client.getUsername());
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
        // 1. Load REAL current dataset revision N
        const ws = await this.loadWorkspaceRevision(owner, slug);
        // 2. Concurrency Conflict Guard: verify expected fingerprint before doing ANY write or upload
        if (args.expectedWorkspaceFingerprint !== ws.workspaceFingerprint) {
            throw new Error(JSON.stringify({
                error: 'KAGGLE_WORKSPACE_CONFLICT',
                message: 'Workspace files have changed since last inspection',
                expectedFingerprint: args.expectedWorkspaceFingerprint,
                currentFingerprint: ws.workspaceFingerprint
            }));
        }
        // 3. Save Pre-Write Snapshot to storage
        const preWriteSnapshotId = await this.saveProjectSnapshot(ref, 'workspace-pre-write-snapshot', JSON.stringify(ws.manifest, null, 2), ws.manifest, undefined, args.clientRequestId);
        // 4. Construct the complete Next Version (N + 1)
        const nextFilesMap = { ...ws.manifest.files };
        const nextFileContents = new Map();
        const changesMap = new Map();
        for (const change of args.changes) {
            if (!change.path || typeof change.content !== 'string') {
                throw new Error('INVALID_CHANGE_SPEC: Each change item must have string "path" and "content"');
            }
            const validPath = (0, workspace_manager_1.validateWorkspaceRelativePath)(change.path);
            changesMap.set(validPath, change);
        }
        // For every unchanged file in current manifest: preserve exact content
        for (const existingPath of Object.keys(ws.manifest.files || {})) {
            if (existingPath === 'devspace-project.json' || existingPath === 'devspace-execution-context.json')
                continue;
            if (!changesMap.has(existingPath)) {
                const storageInfo = ws.resolvedStorage.get(existingPath);
                const storagePath = storageInfo ? storageInfo.storagePath : existingPath;
                let fileDl;
                try {
                    fileDl = await client.downloadDatasetFile(owner, slug, storagePath, ws.version);
                }
                catch (err) {
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
        const nextManifest = {
            ...ws.manifest,
            version: nextVersion,
            files: nextFilesMap,
            entrypoint: args.experimentEntrypoint || ws.manifest.entrypoint,
            updatedAt: new Date().toISOString()
        };
        const nextFingerprint = (0, workspace_manager_1.computeWorkspaceFingerprint)(nextManifest);
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
        const flatUploadedEntries = [];
        for (const [filePath, buf] of nextFileContents.entries()) {
            const fileName = filePath.split('/').pop();
            const token = await client.uploadBlob(fileName, buf);
            flatUploadedEntries.push({ relPath: filePath, token });
        }
        // 6. Build hierarchical upload tree preserving directory structures
        const uploadTree = (0, workspace_manager_1.buildKaggleUploadTree)(flatUploadedEntries);
        // 7. Create Dataset Version
        const datasetResult = await client.createDatasetVersion(slug, `DevSpace Workspace Version ${nextVersion}: ${args.reason}`, uploadTree.files, uploadTree.directories);
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
        const postWriteSnapshotId = await this.saveProjectSnapshot(ref, 'workspace-post-write-snapshot', JSON.stringify(verifiedWs.manifest, null, 2), verifiedWs.manifest, undefined, args.clientRequestId);
        // 11. Execute Existing Canonical Runner (Zero synthetic stub, verified before & after SHA)
        const runnerKernelRef = args.runnerKernelRef || verifiedWs.manifest.runnerKernelRef || `${owner}/astor-tuneup-thin-runner`;
        const runnerExecution = await this.runExistingWorkspaceRunner({
            runnerKernelRef,
            workspaceDatasetRef: ref,
            expectedVersion: verifiedWs.version,
            expectedFingerprint: verifiedWs.workspaceFingerprint,
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
            runnerSourceShaBefore: runnerExecution.runnerSourceShaBefore,
            runnerSourceShaAfter: runnerExecution.runnerSourceShaAfter,
            preWriteSnapshotId,
            postWriteSnapshotId,
            message: `Workspace updated to version ${verifiedWs.version} and canonical runner kernel queued for execution.`
        };
    }
}
exports.McpHandlers = McpHandlers;
