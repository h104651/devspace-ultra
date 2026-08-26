import { TaskStore } from '../storage/task-store';
import { IdempotencyStore } from '../storage/idempotency-store';
import { KaggleBackend } from '../kaggle/backend';
import { SwarmOrchestrator } from '../swarm/swarm-orchestrator';
import { KillSwitch } from '../security/kill-switch';
import { AuditLogger } from '../security/audit-logger';
import { ScopeChecker } from '../security/scope-checker';
import { CreateTaskOptions, DurableTask } from '../types/task';
import { KaggleTaskPayload } from '../types/kaggle';
import { SwarmTaskSpec } from '../types/swarm';

export class TaskRouter {
  private taskStore: TaskStore;
  private idempotencyStore: IdempotencyStore;
  private kaggleBackend: KaggleBackend;
  private swarmOrchestrator: SwarmOrchestrator;
  private killSwitch: KillSwitch;
  private auditLogger: AuditLogger;

  constructor(
    taskStore: TaskStore,
    idempotencyStore: IdempotencyStore,
    kaggleBackend: KaggleBackend,
    swarmOrchestrator: SwarmOrchestrator,
    killSwitch: KillSwitch,
    auditLogger: AuditLogger
  ) {
    this.taskStore = taskStore;
    this.idempotencyStore = idempotencyStore;
    this.kaggleBackend = kaggleBackend;
    this.swarmOrchestrator = swarmOrchestrator;
    this.killSwitch = killSwitch;
    this.auditLogger = auditLogger;
  }

  public async routeTaskSubmit<TPayload = any>(
    options: CreateTaskOptions<TPayload>,
    callerScopes: string[],
    actorId: string
  ): Promise<{ taskId: string; status: string; task: DurableTask<TPayload>; isReplay: boolean }> {
    // 1. Check Idempotency Key
    const idempKey = options.idempotencyKey || options.clientRequestId || options.taskKey;
    if (idempKey) {
      const cached = this.idempotencyStore.get(idempKey);
      if (cached) {
        return {
          taskId: cached.taskId,
          status: cached.status,
          task: cached,
          isReplay: true
        };
      }
    }

    // 2. Check Kill Switch
    const killCheck = this.killSwitch.isExecutionAllowed(options.backend);
    if (!killCheck.allowed) {
      this.auditLogger.log({
        actor: actorId,
        actorType: 'client',
        action: 'TASK_SUBMIT_DENIED',
        result: 'DENY',
        details: { reason: killCheck.reason, capability: options.capability }
      });
      throw new Error(`KILL_SWITCH_ACTIVE: ${killCheck.reason}`);
    }

    // 3. Check Scope Authorization
    const requiredScope = options.requiredScope || ScopeChecker.getRequiredScopeForCapability(options.capability);
    if (!ScopeChecker.hasScope(callerScopes, requiredScope)) {
      this.auditLogger.log({
        actor: actorId,
        actorType: 'client',
        action: 'TASK_SUBMIT_DENIED',
        result: 'DENY',
        details: { requiredScope, callerScopes, capability: options.capability }
      });
      throw new Error(`AUTH_FORBIDDEN: Required scope '${requiredScope}' not granted`);
    }

    // 4. Create Durable Task in Store
    const task = this.taskStore.createTask(options);

    this.auditLogger.log({
      actor: actorId,
      actorType: 'client',
      action: 'TASK_SUBMIT',
      taskId: task.taskId,
      resource: options.capability,
      scopeUsed: requiredScope,
      result: 'SUCCESS'
    });

    // 5. Backend-specific dispatch
    if (task.backend === 'kaggle') {
      await this.kaggleBackend.submitKaggleTask(task as unknown as DurableTask<KaggleTaskPayload>);
    } else if (task.backend === 'swarm') {
      this.swarmOrchestrator.dispatchTask(task.payload as unknown as SwarmTaskSpec);
    }

    const currentTask = this.taskStore.getTask(task.taskId) || task;

    const response = {
      taskId: task.taskId,
      status: currentTask.status,
      task: currentTask as unknown as DurableTask<TPayload>,
      isReplay: false
    };

    if (idempKey) {
      this.idempotencyStore.set(idempKey, currentTask);
    }

    return response;
  }
}
