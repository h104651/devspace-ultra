"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskRouter = void 0;
const scope_checker_1 = require("../security/scope-checker");
const capabilities_1 = require("../local-agent/capabilities");
class TaskRouter {
    taskStore;
    idempotencyStore;
    kaggleBackend;
    swarmOrchestrator;
    killSwitch;
    auditLogger;
    connectionManager;
    authManager;
    constructor(taskStore, idempotencyStore, kaggleBackend, swarmOrchestrator, killSwitch, auditLogger, connectionManager, authManager) {
        this.taskStore = taskStore;
        this.idempotencyStore = idempotencyStore;
        this.kaggleBackend = kaggleBackend;
        this.swarmOrchestrator = swarmOrchestrator;
        this.killSwitch = killSwitch;
        this.auditLogger = auditLogger;
        this.connectionManager = connectionManager;
        this.authManager = authManager;
    }
    setConnectionManager(cm) {
        this.connectionManager = cm;
    }
    setAuthManager(am) {
        this.authManager = am;
    }
    getConnectionManager() {
        return this.connectionManager;
    }
    getAuthManager() {
        return this.authManager;
    }
    async routeTaskSubmit(options, callerScopes, actorId) {
        const killCheck = this.killSwitch.isExecutionAllowed(options.backend);
        if (!killCheck.allowed) {
            this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT_DENIED', result: 'DENY', details: { reason: killCheck.reason, capability: options.capability } });
            throw new Error(`KILL_SWITCH_ACTIVE: ${killCheck.reason}`);
        }
        const requiredScope = options.backend === 'local'
            ? scope_checker_1.ScopeChecker.getRequiredScopeForCapability(options.capability)
            : options.requiredScope || scope_checker_1.ScopeChecker.getRequiredScopeForCapability(options.capability);
        const hasCapabilityScope = scope_checker_1.ScopeChecker.hasScope(callerScopes, requiredScope);
        const hasGenericSubmitScope = scope_checker_1.ScopeChecker.hasScope(callerScopes, 'tasks:submit');
        if (options.backend === 'local') {
            const missingGenericSubmit = !hasGenericSubmitScope;
            const missingCapabilityScope = !hasCapabilityScope;
            if (missingGenericSubmit || missingCapabilityScope) {
                this.auditLogger.log({
                    actor: actorId,
                    actorType: 'client',
                    action: 'TASK_SUBMIT_DENIED',
                    result: 'DENY',
                    details: {
                        backend: 'local',
                        capability: options.capability,
                        requiredCapabilityScope: requiredScope,
                        missingGenericSubmit,
                        missingCapabilityScope
                    }
                });
                const missingList = [];
                if (missingGenericSubmit)
                    missingList.push("'tasks:submit'");
                if (missingCapabilityScope)
                    missingList.push(`'${requiredScope}'`);
                throw new Error(`AUTH_FORBIDDEN: Local task submission requires both 'tasks:submit' and '${requiredScope}'. Missing: ${missingList.join(', ')}`);
            }
            if (!(0, capabilities_1.isLocalExecutableCapability)(options.capability)) {
                this.auditLogger.log({
                    actor: actorId,
                    actorType: 'client',
                    action: 'TASK_SUBMIT_DENIED',
                    result: 'DENY',
                    details: { reason: 'UNSUPPORTED_LOCAL_CAPABILITY', capability: options.capability }
                });
                throw new Error(`UNSUPPORTED_LOCAL_CAPABILITY: '${options.capability}' is not a recognized local executable capability. Supported: ${capabilities_1.LOCAL_EXECUTABLE_CAPABILITIES.join(', ')}`);
            }
            // Multi-device targeted routing enforcement: only consider healthy, unrevoked connected sessions
            const connected = (this.connectionManager && typeof this.connectionManager.getConnectedAgents === 'function')
                ? (this.connectionManager.getConnectedAgents({ healthyOnly: true }) || [])
                : [];
            const distinctDevices = Array.from(new Set(connected.map((a) => String(a.deviceId)).filter(Boolean)));
            const registeredDevices = (this.authManager && typeof this.authManager.listDevices === 'function')
                ? this.authManager.listDevices().filter((d) => d.status !== 'revoked')
                : [];
            const allKnownDevices = Array.from(new Set([
                ...registeredDevices.map((d) => String(d.deviceId)),
                ...distinctDevices
            ]));
            if (!options.targetDeviceId) {
                if (allKnownDevices.length > 1) {
                    this.auditLogger.log({
                        actor: actorId,
                        actorType: 'client',
                        action: 'TASK_SUBMIT_DENIED',
                        result: 'DENY',
                        details: { reason: 'AMBIGUOUS_DEVICE_TARGET', registeredDevices: registeredDevices.map((d) => d.deviceId), connectedDevices: distinctDevices, capability: options.capability }
                    });
                    throw new Error(`AMBIGUOUS_DEVICE_TARGET: Multiple local devices exist (${allKnownDevices.join(', ')}). You must explicitly specify 'targetDeviceId' for local tasks to prevent misrouting.`);
                }
                else if (allKnownDevices.length === 1) {
                    // Exactly 1 registered or connected device: auto-bind safely for backwards compatibility
                    options.targetDeviceId = allKnownDevices[0];
                }
                else {
                    // 0 registered, 0 online, no targetDeviceId specified -> fail closed!
                    this.auditLogger.log({
                        actor: actorId,
                        actorType: 'client',
                        action: 'TASK_SUBMIT_DENIED',
                        result: 'DENY',
                        details: { reason: 'DEVICE_TARGET_REQUIRED', registeredDevices: [], connectedDevices: [], capability: options.capability }
                    });
                    throw new Error(`DEVICE_TARGET_REQUIRED: No local agents are registered or online. You must register a device or explicitly specify 'targetDeviceId' for local tasks.`);
                }
            }
            else {
                if (typeof options.targetDeviceId !== 'string' || options.targetDeviceId.trim().length === 0) {
                    throw new Error('INVALID_ARGUMENT: targetDeviceId must be a non-empty string');
                }
                options.targetDeviceId = options.targetDeviceId.trim();
            }
        }
        else {
            if (!hasCapabilityScope && !hasGenericSubmitScope) {
                this.auditLogger.log({
                    actor: actorId,
                    actorType: 'client',
                    action: 'TASK_SUBMIT_DENIED',
                    result: 'DENY',
                    details: {
                        backend: options.backend,
                        requiredScope,
                        callerScopes,
                        capability: options.capability
                    }
                });
                throw new Error(`AUTH_FORBIDDEN: Required scope '${requiredScope}' or 'tasks:submit' not granted`);
            }
        }
        // Idempotency resolution: checked after authorization and parameter normalization
        const idempKey = options.idempotencyKey || options.clientRequestId || options.taskKey;
        if (idempKey) {
            const cached = await this.idempotencyStore.getDurable(idempKey);
            if (cached) {
                const reqTarget = options.targetDeviceId?.trim() || undefined;
                const cachedTarget = cached.targetDeviceId?.trim() || undefined;
                if (reqTarget !== cachedTarget) {
                    this.auditLogger.log({
                        actor: actorId,
                        actorType: 'client',
                        action: 'TASK_SUBMIT_DENIED',
                        result: 'DENY',
                        details: {
                            reason: 'IDEMPOTENCY_CONFLICT',
                            idempotencyKey: idempKey,
                            cachedTargetDeviceId: cachedTarget,
                            requestedTargetDeviceId: reqTarget
                        }
                    });
                    throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' was previously bound to targetDeviceId '${cachedTarget}', but request specified '${reqTarget}'.`);
                }
                if (options.backend && cached.backend && options.backend !== cached.backend) {
                    throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' was previously bound to backend '${cached.backend}', but request specified '${options.backend}'.`);
                }
                if (options.capability && cached.capability && options.capability !== cached.capability) {
                    throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' was previously bound to capability '${cached.capability}', but request specified '${options.capability}'.`);
                }
                if (options.payload !== undefined && cached.payload !== undefined) {
                    if (JSON.stringify(options.payload) !== JSON.stringify(cached.payload)) {
                        throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' payload mismatch.`);
                    }
                }
                return { taskId: cached.taskId, status: cached.status, task: cached, isReplay: true };
            }
        }
        // Execution tasks must not become latent work on an ineligible or offline device.
        // Existing read-only bounded wait and legacy file-task routing remain unchanged.
        if (options.backend === 'local' && (options.capability === 'local:run_tests' || options.capability === 'local:build_project')) {
            const agents = this.connectionManager?.getConnectedAgents?.({ healthyOnly: true }) || [];
            const eligible = agents.some((agent) => agent.deviceId === options.targetDeviceId && agent.capabilities?.includes(options.capability));
            if (!eligible) {
                this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT_DENIED', result: 'DENY', details: { reason: 'EXECUTION_TARGET_NOT_ELIGIBLE', capability: options.capability, targetDeviceId: options.targetDeviceId } });
                throw new Error('EXECUTION_TARGET_NOT_ELIGIBLE: Execution requires a healthy target advertising the requested capability.');
            }
        }
        const task = this.taskStore.createTask(options);
        this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT', taskId: task.taskId, resource: options.capability, scopeUsed: hasCapabilityScope ? requiredScope : 'tasks:submit', result: 'SUCCESS' });
        if (task.backend === 'kaggle') {
            await this.kaggleBackend.submitKaggleTask(task);
        }
        // A generic backend='swarm' task remains queued for a worker to claim. The
        // dedicated swarm_dispatch tool uses SwarmOrchestrator.dispatchTask and must
        // not create a second duplicate TaskStore record here.
        const currentTask = this.taskStore.getTask(task.taskId) || task;
        const response = { taskId: task.taskId, status: currentTask.status, task: currentTask, isReplay: false };
        if (idempKey)
            await this.idempotencyStore.setDurable(idempKey, currentTask);
        return response;
    }
    cancelTask(taskId, reason, callerScopes, actorId) {
        if (!scope_checker_1.ScopeChecker.hasScope(callerScopes, 'tasks:cancel')) {
            this.auditLogger.log({
                actor: actorId,
                actorType: 'client',
                action: 'TASK_CANCEL_DENIED',
                taskId,
                result: 'DENY',
                details: { callerScopes }
            });
            throw new Error("AUTH_FORBIDDEN: Required scope 'tasks:cancel' not granted");
        }
        const task = this.taskStore.getTask(taskId);
        if (!task)
            throw new Error(`TASK_NOT_FOUND: ${taskId}`);
        const cancelled = this.taskStore.cancelTask(taskId, reason);
        const current = this.taskStore.getTask(taskId) || task;
        this.auditLogger.log({
            actor: actorId,
            actorType: 'client',
            action: 'TASK_CANCEL',
            taskId,
            result: cancelled ? 'SUCCESS' : 'DENY',
            details: { reason, status: current.status }
        });
        return { taskId, status: current.status, cancelled };
    }
}
exports.TaskRouter = TaskRouter;
