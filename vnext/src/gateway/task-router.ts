import { TaskStore } from '../storage/task-store';
import { IdempotencyStore } from '../storage/idempotency-store';
import { KaggleBackend } from '../kaggle/backend';
import { SwarmOrchestrator } from '../swarm/swarm-orchestrator';
import { KillSwitch } from '../security/kill-switch';
import { AuditLogger } from '../security/audit-logger';
import { ScopeChecker } from '../security/scope-checker';
import { CreateTaskOptions, DurableTask } from '../types/task';
import { KaggleTaskPayload } from '../types/kaggle';

export class TaskRouter {
  constructor(
    private taskStore: TaskStore,
    private idempotencyStore: IdempotencyStore,
    private kaggleBackend: KaggleBackend,
    private swarmOrchestrator: SwarmOrchestrator,
    private killSwitch: KillSwitch,
    private auditLogger: AuditLogger
  ) {}

  public async routeTaskSubmit<TPayload = any>(
    options: CreateTaskOptions<TPayload>,
    callerScopes: string[],
    actorId: string
  ): Promise<{ taskId: string; status: string; task: DurableTask<TPayload>; isReplay: boolean }> {
    const idempKey = options.idempotencyKey || options.clientRequestId || options.taskKey;
    if (idempKey) {
      const cached = await this.idempotencyStore.getDurable(idempKey);
      if (cached) return { taskId: cached.taskId, status: cached.status, task: cached, isReplay: true };
    }

    const killCheck = this.killSwitch.isExecutionAllowed(options.backend);
    if (!killCheck.allowed) {
      this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT_DENIED', result: 'DENY', details: { reason: killCheck.reason, capability: options.capability } });
      throw new Error(`KILL_SWITCH_ACTIVE: ${killCheck.reason}`);
    }

    const requiredScope = options.requiredScope || ScopeChecker.getRequiredScopeForCapability(options.capability);
    const hasCapabilityScope = ScopeChecker.hasScope(callerScopes, requiredScope);
    const hasGenericSubmitScope = ScopeChecker.hasScope(callerScopes, 'tasks:submit');
    if (!hasCapabilityScope && !hasGenericSubmitScope) {
      this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT_DENIED', result: 'DENY', details: { requiredScope, callerScopes, capability: options.capability } });
      throw new Error(`AUTH_FORBIDDEN: Required scope '${requiredScope}' or 'tasks:submit' not granted`);
    }

    const task = this.taskStore.createTask(options);
    this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT', taskId: task.taskId, resource: options.capability, scopeUsed: hasCapabilityScope ? requiredScope : 'tasks:submit', result: 'SUCCESS' });

    if (task.backend === 'kaggle') {
      await this.kaggleBackend.submitKaggleTask(task as unknown as DurableTask<KaggleTaskPayload>);
    }
    // A generic backend='swarm' task remains queued for a worker to claim. The
    // dedicated swarm_dispatch tool uses SwarmOrchestrator.dispatchTask and must
    // not create a second duplicate TaskStore record here.

    const currentTask = this.taskStore.getTask(task.taskId) || task;
    const response = { taskId: task.taskId, status: currentTask.status, task: currentTask as unknown as DurableTask<TPayload>, isReplay: false };
    if (idempKey) await this.idempotencyStore.setDurable(idempKey, currentTask);
    return response;
  }

  public cancelTask(
    taskId: string,
    reason: string,
    callerScopes: string[],
    actorId: string
  ): { taskId: string; status: string; cancelled: boolean } {
    if (!ScopeChecker.hasScope(callerScopes, 'tasks:cancel')) {
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
    if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);

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
