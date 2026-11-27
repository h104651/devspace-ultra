"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REMOTE_TASK_WAIT_TOOL = void 0;
exports.handleRemoteTaskWait = handleRemoteTaskWait;
const scope_checker_1 = require("../security/scope-checker");
const redactor_1 = require("../security/redactor");
exports.REMOTE_TASK_WAIT_TOOL = {
    name: 'remote_task_wait',
    description: 'Wait event-driven for a durable task to reach a terminal state, with a bounded timeout',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: { type: 'string', description: 'ID of the durable task to wait for' },
            timeoutMs: {
                type: 'number',
                minimum: 0,
                maximum: 120000,
                default: 30000,
                description: 'Maximum wait in milliseconds before returning the current non-terminal snapshot'
            }
        },
        required: ['taskId'],
        additionalProperties: false
    }
};
async function handleRemoteTaskWait(taskStore, args, callerScopes) {
    if (!scope_checker_1.ScopeChecker.hasScope(callerScopes, 'tasks:read')) {
        throw new Error("AUTH_FORBIDDEN: Required scope 'tasks:read' not granted");
    }
    if (!args || typeof args.taskId !== 'string' || args.taskId.length === 0) {
        throw new Error('TASK_WAIT_INVALID: taskId is required');
    }
    const rawTimeout = args.timeoutMs ?? 30000;
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout < 0 || rawTimeout > 120000) {
        throw new Error('TASK_WAIT_INVALID: timeoutMs must be a number between 0 and 120000');
    }
    const timeoutMs = Math.floor(rawTimeout);
    if (taskStore.getTask(args.taskId)?.capability === 'local:git_read' && !scope_checker_1.ScopeChecker.hasScope(callerScopes, 'local:git:read')) {
        throw new Error("AUTH_FORBIDDEN: Required scope 'local:git:read' not granted");
    }
    const waited = await taskStore.waitForTask(args.taskId, { timeoutMs });
    const task = waited.task;
    if (task.capability === 'local:git_read' && !scope_checker_1.ScopeChecker.hasScope(callerScopes, 'local:git:read')) {
        throw new Error("AUTH_FORBIDDEN: Required scope 'local:git:read' not granted");
    }
    return {
        taskId: task.taskId,
        backend: task.backend,
        capability: task.capability,
        status: task.status,
        timedOut: waited.timedOut,
        result: (0, redactor_1.redactObject)(task.result),
        error: task.error,
        attemptCount: task.attempts?.length || 0,
        createdAt: new Date(task.createdAt).toISOString(),
        startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
        completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined
    };
}
