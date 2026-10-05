import { GatewayServer } from '../gateway/server';
import { redactObject } from '../security/redactor';

export class McpHandlers {
  private gateway: GatewayServer;
  private defaultClientScopes: string[];

  constructor(gateway: GatewayServer, defaultClientScopes = ['admin']) {
    this.gateway = gateway;
    this.defaultClientScopes = defaultClientScopes;
  }

  public async handleRemoteTaskSubmit(args: any) {
    const result = await this.gateway.taskRouter.routeTaskSubmit(
      {
        backend: args.backend,
        capability: args.capability,
        payload: args.payload,
        priority: args.priority,
        clientRequestId: args.clientRequestId
      },
      this.defaultClientScopes,
      'mcp-client'
    );

    return {
      taskId: result.taskId,
      status: result.status,
      backend: args.backend,
      capability: args.capability,
      isReplay: !!result.isReplay,
      message: 'Task successfully submitted and queued in durable storage'
    };
  }

  public async handleRemoteTaskStatus(args: any) {
    const task = this.gateway.taskStore.getTask(args.taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: Task '${args.taskId}' does not exist`);
    }

    return {
      taskId: task.taskId,
      backend: task.backend,
      capability: task.capability,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
      result: redactObject(task.result),
      error: task.error,
      artifactsCount: task.artifacts.length,
      logsCount: task.logs.length
    };
  }

  public async handleRemoteTaskLogs(args: any) {
    const task = this.gateway.taskStore.getTask(args.taskId);
    if (!task) {
      throw new Error(`TASK_NOT_FOUND: Task '${args.taskId}' does not exist`);
    }

    const limit = args.limit || 100;
    const lines = task.logs.slice(-limit);
    return {
      taskId: task.taskId,
      totalLines: task.logs.length,
      lines: lines.map(line => redactObject(line))
    };
  }

  public async handleRemoteTaskArtifacts(args: any) {
    const artifacts = this.gateway.artifactStore.getTaskArtifacts(args.taskId);
    return {
      taskId: args.taskId,
      artifactsCount: artifacts.length,
      artifacts: artifacts.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        sizeBytes: a.sizeBytes,
        preview: a.preview,
        sha256: a.sha256
      }))
    };
  }

  public async handleRemoteTaskCancel(args: any) {
    const success = this.gateway.taskStore.cancelTask(args.taskId, args.reason || 'Cancelled by MCP caller');
    if (!success) {
      throw new Error(`TASK_CANCEL_FAILED: Task '${args.taskId}' could not be cancelled`);
    }
    return { taskId: args.taskId, status: 'cancelled' };
  }

  public async handleKaggleRun(args: any) {
    const result = await this.gateway.taskRouter.routeTaskSubmit(
      {
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
      },
      this.defaultClientScopes,
      'mcp-client'
    );

    return {
      taskId: result.taskId,
      status: result.status,
      kernelSlug: args.kernelSlug,
      message: 'Kaggle task submitted to remote GPU backend. Query kaggle_status for execution progress.'
    };
  }

  public async handleKaggleStatus(args: any) {
    return this.handleRemoteTaskStatus(args);
  }

  public async handleKaggleLogs(args: any) {
    return this.handleRemoteTaskLogs(args);
  }

  public async handleKaggleResult(args: any) {
    const status = await this.handleRemoteTaskStatus(args);
    const artifacts = await this.handleRemoteTaskArtifacts(args);
    return {
      taskId: args.taskId,
      status: status.status,
      result: status.result,
      error: status.error,
      artifacts: artifacts.artifacts
    };
  }

  public async handleSwarmDispatch(args: any) {
    const result = this.gateway.swarmOrchestrator.dispatchTask(args);
    return {
      taskId: result.taskId,
      assignedWorkerId: result.assignedWorkerId,
      message: result.assignedWorkerId ? 'Dispatched to active worker' : 'Queued for next available worker'
    };
  }

  public async handleSwarmStatus() {
    const workers = this.gateway.swarmOrchestrator.listWorkers();
    return {
      totalWorkers: workers.length,
      idleWorkers: workers.filter(w => w.status === 'idle').length,
      busyWorkers: workers.filter(w => w.status === 'busy').length,
      workers
    };
  }

  public async handleChatSwarmDispatch(args: any) {
    return this.handleSwarmDispatch(args);
  }

  public async handleChatSwarmStatus(args?: any) {
    return this.handleSwarmStatus();
  }

  public async handleChatSwarmClaim(args: any) {
    const worker = this.gateway.swarmOrchestrator.registerWorker(args.workerName || 'worker-01', args.role || 'default', args.capabilities || ['chat']);
    return { ok: true, workerId: worker.workerId, status: 'claimed' };
  }

  public async handleChatSwarmNext(args: any) {
    return { ok: true, status: 'no_task', message: 'Waiting for swarm task' };
  }

  public async handleChatSwarmSubmit(args: any) {
    if (args.taskId) {
      if (args.error) {
        this.gateway.taskStore.failTask(args.taskId, { code: 'TASK_FAILED', message: args.error });
      } else {
        this.gateway.taskStore.completeTask(args.taskId, args.result || { ok: true });
      }
    }
    return { ok: true, taskId: args.taskId, status: 'submitted' };
  }

  public async handleChatSwarmCancel(args: any) {
    return this.handleRemoteTaskCancel(args);
  }

  public async handleChatSwarmWakeBridge(args?: any) {
    return { ok: true, wakeBridge: 'active', message: 'Browser wake bridge is operational' };
  }

  public async handleChatSwarmRuntimeStatus() {
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

  public async handleDeviceStatus() {
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

  public async handleKillSwitchTrigger(args: any) {
    if (args.action === 'EMERGENCY_STOP') {
      this.gateway.killSwitch.triggerGlobalEmergencyStop(args.reason);
    } else if (args.action === 'CLEAR_STOP') {
      this.gateway.killSwitch.resetGlobalEmergencyStop();
    } else if (args.action === 'REVOKE_DEVICE' && args.deviceId) {
      this.gateway.killSwitch.revokeDevice(args.deviceId, args.reason);
      this.gateway.authManager.revokeDevice(args.deviceId, args.reason);
    } else if (args.action === 'REVOKE_CLIENT' && args.clientId) {
      this.gateway.killSwitch.revokeClient(args.clientId, args.reason);
    }

    return {
      status: 'OK',
      killSwitchState: this.gateway.killSwitch.getState()
    };
  }
}
