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
    constructor(taskStore, idempotencyStore, kaggleBackend, swarmOrchestrator, killSwitch, auditLogger) {
        this.taskStore = taskStore;
        this.idempotencyStore = idempotencyStore;
        this.kaggleBackend = kaggleBackend;
        this.swarmOrchestrator = swarmOrchestrator;
        this.killSwitch = killSwitch;
        this.auditLogger = auditLogger;
    }
    async routeTaskSubmit(options, callerScopes, actorId) {
        const idempKey = options.idempotencyKey || options.clientRequestId || options.taskKey;
        if (idempKey) {
            const cached = await this.idempotencyStore.getDurable(idempKey);
            if (cached)
                return { taskId: cached.taskId, status: cached.status, task: cached, isReplay: true };
        }
        if (options.backend === 'local') {
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
        }
        const killCheck = this.killSwitch.isExecutionAllowed(options.backend);
        if (!killCheck.allowed) {
            this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT_DENIED', result: 'DENY', details: { reason: killCheck.reason, capability: options.capability } });
            throw new Error(`KILL_SWITCH_ACTIVE: ${killCheck.reason}`);
        }
        const requiredScope = options.requiredScope || scope_checker_1.ScopeChecker.getRequiredScopeForCapability(options.capability);
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
