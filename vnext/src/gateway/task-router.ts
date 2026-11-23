import { TaskStore } from '../storage/task-store';
import { IdempotencyStore } from '../storage/idempotency-store';
import { KaggleBackend } from '../kaggle/backend';
import { SwarmOrchestrator } from '../swarm/swarm-orchestrator';
import { KillSwitch } from '../security/kill-switch';
import { AuditLogger } from '../security/audit-logger';
import { ScopeChecker } from '../security/scope-checker';
import { isLocalExecutableCapability, LOCAL_EXECUTABLE_CAPABILITIES } from '../local-agent/capabilities';
import { CreateTaskOptions, DurableTask } from '../types/task';
import { KaggleTaskPayload } from '../types/kaggle';

export class TaskRouter {
  constructor(
    private taskStore: TaskStore,
    private idempotencyStore: IdempotencyStore,
    private kaggleBackend: KaggleBackend,
    private swarmOrchestrator: SwarmOrchestrator,
    private killSwitch: KillSwitch,
    private auditLogger: AuditLogger,
    private connectionManager?: { getConnectedAgents(): Array<{ deviceId: string }> } | any,
    private authManager?: any
  ) {}

  public async routeTaskSubmit<TPayload = any>(
    options: CreateTaskOptions<TPayload>,
    callerScopes: string[],
    actorId: string
  ): Promise<{ taskId: string; status: string; task: DurableTask<TPayload>; isReplay: boolean }> {
    const idempKey = options.idempotencyKey || options.clientRequestId || options.taskKey;
    if (idempKey) {
      const cached = await this.idempotencyStore.getDurable(idempKey);
      if (cached) {
        // Enforce parameter matching on idempotency replay to prevent cross-device or cross-capability pollution
        if (options.targetDeviceId && cached.targetDeviceId && options.targetDeviceId !== cached.targetDeviceId) {
          this.auditLogger.log({
            actor: actorId,
            actorType: 'client',
            action: 'TASK_SUBMIT_DENIED',
            result: 'DENY',
            details: {
              reason: 'IDEMPOTENCY_CONFLICT',
              idempotencyKey: idempKey,
              cachedTargetDeviceId: cached.targetDeviceId,
              requestedTargetDeviceId: options.targetDeviceId
            }
          });
          throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' was previously bound to targetDeviceId '${cached.targetDeviceId}', but request specified '${options.targetDeviceId}'.`);
        }
        if (options.backend && cached.backend && options.backend !== cached.backend) {
          throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' was previously bound to backend '${cached.backend}', but request specified '${options.backend}'.`);
        }
        if (options.capability && cached.capability && options.capability !== cached.capability) {
          throw new Error(`IDEMPOTENCY_CONFLICT: Idempotency key '${idempKey}' was previously bound to capability '${cached.capability}', but request specified '${options.capability}'.`);
        }
        return { taskId: cached.taskId, status: cached.status, task: cached, isReplay: true };
      }
    }

    const killCheck = this.killSwitch.isExecutionAllowed(options.backend);
    if (!killCheck.allowed) {
      this.auditLogger.log({ actor: actorId, actorType: 'client', action: 'TASK_SUBMIT_DENIED', result: 'DENY', details: { reason: killCheck.reason, capability: options.capability } });
      throw new Error(`KILL_SWITCH_ACTIVE: ${killCheck.reason}`);
    }

    const requiredScope = options.requiredScope || ScopeChecker.getRequiredScopeForCapability(options.capability);
    const hasCapabilityScope = ScopeChecker.hasScope(callerScopes, requiredScope);
    const hasGenericSubmitScope = ScopeChecker.hasScope(callerScopes, 'tasks:submit');

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
        const missingList: string[] = [];
        if (missingGenericSubmit) missingList.push("'tasks:submit'");
        if (missingCapabilityScope) missingList.push(`'${requiredScope}'`);
        throw new Error(`AUTH_FORBIDDEN: Local task submission requires both 'tasks:submit' and '${requiredScope}'. Missing: ${missingList.join(', ')}`);
      }

      if (!isLocalExecutableCapability(options.capability)) {
        this.auditLogger.log({
          actor: actorId,
          actorType: 'client',
          action: 'TASK_SUBMIT_DENIED',
          result: 'DENY',
          details: { reason: 'UNSUPPORTED_LOCAL_CAPABILITY', capability: options.capability }
        });
        throw new Error(`UNSUPPORTED_LOCAL_CAPABILITY: '${options.capability}' is not a recognized local executable capability. Supported: ${LOCAL_EXECUTABLE_CAPABILITIES.join(', ')}`);
      }

      // Multi-device targeted routing enforcement
      const connected = (this.connectionManager && typeof this.connectionManager.getConnectedAgents === 'function')
        ? (this.connectionManager.getConnectedAgents() || [])
        : [];
      const distinctDevices: string[] = Array.from(new Set<string>(connected.map((a: any) => String(a.deviceId)).filter(Boolean)));
      const registeredDevices: any[] = (this.authManager && typeof this.authManager.listDevices === 'function')
        ? this.authManager.listDevices().filter((d: any) => d.status !== 'revoked')
        : [];

      if (!options.targetDeviceId) {
        if (distinctDevices.length > 1) {
          this.auditLogger.log({
            actor: actorId,
            actorType: 'client',
            action: 'TASK_SUBMIT_DENIED',
            result: 'DENY',
            details: { reason: 'AMBIGUOUS_DEVICE_TARGET', connectedDevices: distinctDevices, capability: options.capability }
          });
          throw new Error(`AMBIGUOUS_DEVICE_TARGET: Multiple local agents are online (${distinctDevices.join(', ')}). You must explicitly specify 'targetDeviceId' for local tasks to prevent misrouting.`);
        } else if (distinctDevices.length === 1) {
          // Auto-bind to single online device for backwards compatibility
          options.targetDeviceId = distinctDevices[0];
        } else if (registeredDevices.length > 1) {
          // 0 agents online, but multiple devices are registered in the gateway!
          this.auditLogger.log({
            actor: actorId,
            actorType: 'client',
            action: 'TASK_SUBMIT_DENIED',
            result: 'DENY',
            details: { reason: 'AMBIGUOUS_DEVICE_TARGET', registeredDevices: registeredDevices.map((d: any) => d.deviceId), capability: options.capability }
          });
          throw new Error(`AMBIGUOUS_DEVICE_TARGET: No local agent is currently online, and multiple devices are registered (${registeredDevices.map((d: any) => d.deviceId).join(', ')}). You must explicitly specify 'targetDeviceId' for local tasks.`);
        } else if (registeredDevices.length === 1) {
          // 0 agents online, but exactly 1 device is registered in the gateway! Auto-bind safely
          options.targetDeviceId = registeredDevices[0].deviceId;
        }
      } else {
        if (typeof options.targetDeviceId !== 'string' || options.targetDeviceId.trim().length === 0) {
          throw new Error('INVALID_ARGUMENT: targetDeviceId must be a non-empty string');
        }
        options.targetDeviceId = options.targetDeviceId.trim();
      }
    } else {
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
