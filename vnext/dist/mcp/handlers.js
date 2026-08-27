"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpHandlers = void 0;
const redactor_1 = require("../security/redactor");
const scope_checker_1 = require("../security/scope-checker");
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
        return {
            taskId: result.taskId,
            status: result.status,
            kernelSlug: args.kernelSlug,
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
            this.gateway.killSwitch.triggerGlobalEmergencyStop(args.reason);
        }
        else if (args.action === 'CLEAR_STOP') {
            this.gateway.killSwitch.resetGlobalEmergencyStop();
        }
        else if (args.action === 'REVOKE_DEVICE' && args.deviceId) {
            this.gateway.killSwitch.revokeDevice(args.deviceId, args.reason);
            this.gateway.authManager.revokeDevice(args.deviceId, args.reason);
        }
        else if (args.action === 'REVOKE_CLIENT' && args.clientId) {
            this.gateway.killSwitch.revokeClient(args.clientId, args.reason);
        }
        return { status: 'OK', killSwitchState: this.gateway.killSwitch.getState() };
    }
}
exports.McpHandlers = McpHandlers;
