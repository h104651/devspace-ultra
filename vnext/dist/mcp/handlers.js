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
        const cells = (0, project_manager_1.parseNotebookCells)(rawSource);
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Math.min(Math.max(1, Number(args.limit) || 50000), 100000);
        const chunk = rawSource.substring(offset, offset + limit);
        const nextOffset = (offset + limit < rawSource.length) ? (offset + limit) : undefined;
        return {
            kernelRef: ref,
            requestedVersion: args.version,
            kernelType: metadata.kernelType || (cells ? 'notebook' : 'script'),
            sourceFormat: cells ? 'ipynb' : 'script',
            sourceSha256,
            projectFingerprint,
            totalLength: rawSource.length,
            offset,
            content: chunk,
            nextOffset,
            cells: (offset === 0 && cells) ? cells : undefined
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
        const outputRes = await client.downloadKernelOutput(slug);
        if (!outputRes.success || !Array.isArray(outputRes.files) || outputRes.files.length === 0) {
            return {
                kernelRef: ref,
                filesCount: 0,
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
        const maxBytes = args.maxBytes || 1048576;
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
        // Fetch CURRENT project source & metadata
        const current = await client.pullProject(owner, slug);
        const currentRawSource = current.source || '';
        const currentSourceSha256 = crypto.createHash('sha256').update(currentRawSource).digest('hex');
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
        // Prepare mutated source
        const mutation = args.mutation || {};
        let newSource = '';
        if (mutation.type === 'append_notebook_cells') {
            if (!Array.isArray(mutation.cells) || mutation.cells.length === 0) {
                throw new Error('INVALID_MUTATION: cells array is required for append_notebook_cells');
            }
            newSource = (0, project_manager_1.appendCellsToNotebook)(currentRawSource, mutation.cells);
        }
        else if (mutation.type === 'append_script') {
            const codeToAppend = mutation.code || mutation.source || '';
            newSource = currentRawSource + (currentRawSource.endsWith('\n') ? '\n' : '\n\n') + codeToAppend;
        }
        else if (mutation.type === 'replace_source') {
            newSource = mutation.source || mutation.code || '';
            if (!newSource) {
                throw new Error('INVALID_MUTATION: source is required for replace_source');
            }
        }
        else {
            throw new Error(`INVALID_MUTATION_TYPE: Unknown mutation type '${mutation.type}'`);
        }
        // Submit task reusing existing durable pipeline
        const payload = {
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
        const result = await this.gateway.taskRouter.routeTaskSubmit({
            backend: 'kaggle',
            capability: 'kaggle:run',
            payload,
            clientRequestId: args.clientRequestId
        }, auth.scopes, auth.subjectId);
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
}
exports.McpHandlers = McpHandlers;
