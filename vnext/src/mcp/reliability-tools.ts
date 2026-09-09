import { ScopeChecker } from '../security/scope-checker';
import { redactObject } from '../security/redactor';
import { TaskStore } from '../storage/task-store';

export const REMOTE_TASK_WAIT_TOOL = {
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

export async function handleRemoteTaskWait(
  taskStore: TaskStore,
  args: any,
  callerScopes: string[]
): Promise<any> {
  if (!ScopeChecker.hasScope(callerScopes, 'tasks:read')) {
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

  const waited = await taskStore.waitForTask(args.taskId, { timeoutMs });
  const task = waited.task;
  return {
    taskId: task.taskId,
    backend: task.backend,
    capability: task.capability,
    status: task.status,
    timedOut: waited.timedOut,
    result: redactObject(task.result),
    error: task.error,
    attemptCount: task.attempts?.length || 0,
    createdAt: new Date(task.createdAt).toISOString(),
    startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
    completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined
  };
}
