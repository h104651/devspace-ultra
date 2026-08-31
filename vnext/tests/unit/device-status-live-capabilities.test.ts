import * as assert from 'assert';
import { AuthManager } from '../../src/security/auth-manager';
import { McpHandlers } from '../../src/mcp/handlers';
import { TaskStore } from '../../src/storage/task-store';
import { TaskRouter } from '../../src/gateway/task-router';
import { IdempotencyStore } from '../../src/storage/idempotency-store';
import { KillSwitch } from '../../src/security/kill-switch';
import { AuditLogger } from '../../src/security/audit-logger';

export async function runDeviceStatusLiveCapabilitiesUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const masterSecret = '01234567890123456789012345678901';
    const authManager = new AuthManager(masterSecret);
    const killSwitch = new KillSwitch();
    const auditLogger = new AuditLogger();
    const taskStore = new TaskStore();
    const idempotencyStore = new IdempotencyStore();

    // Register a device with old stale capabilities in AuthManager
    const { deviceId, record } = authManager.registerDevice('win-test', 'windows', [
      'local:read_file',
      'local:git_status'
    ]);

    const callerAdmin = {
      valid: true,
      subjectId: 'admin-client',
      scopes: ['admin', 'local:read', 'local:write', 'tasks:submit', 'tasks:read', 'local:exec', 'local:test']
    };

    // 1. When no live connection exists: device_status returns offline with stale recorded capabilities
    let mockConnectedAgents: any[] = [];
    const gatewayMock: any = {
      authManager,
      killSwitch,
      auditLogger,
      taskStore,
      connectionManager: {
        getConnectedAgents: () => mockConnectedAgents
      },
      taskRouter: new TaskRouter(
        taskStore,
        idempotencyStore,
        { submitKaggleTask: async () => {} } as any,
        {} as any,
        killSwitch,
        auditLogger
      )
    };

    const handlers = new McpHandlers(gatewayMock);

    const offlineStatus = await handlers.handleDeviceStatus(callerAdmin);
    assert.strictEqual(offlineStatus.totalOnline, 0);
    assert.strictEqual(offlineStatus.totalConnections, 0);
    const offlineDev = offlineStatus.devices.find((d: any) => d.deviceId === deviceId);
    assert.strictEqual(offlineDev?.status, 'offline');
    assert.deepStrictEqual(offlineDev?.capabilities, ['local:read_file', 'local:git_status']);
    passed++;

    // 1b. When zero online devices: remote_task_submit returns waitingForEligibleDevice with NO_ONLINE_DEVICE
    const submitZeroOnline = await handlers.handleRemoteTaskSubmit({
      backend: 'local',
      capability: 'local:git_status',
      payload: { projectId: 'devspace-ultra' }
    }, callerAdmin);
    assert.strictEqual(submitZeroOnline.status, 'queued');
    assert.strictEqual(submitZeroOnline.waitingForEligibleDevice, true);
    assert.strictEqual(submitZeroOnline.reason, 'NO_ONLINE_DEVICE');
    passed++;

    // 2. When live connection exists with updated PR #3/#4 discovery capabilities:
    // device_status must return LIVE capabilities, overriding the stale record
    const liveCapabilities = [
      'local:list_projects',
      'local:project_status',
      'local:git_status',
      'local:read_file',
      'local:write_file',
      'local:patch_file',
      'local:list_directory',
      'local:find_files',
      'local:search_text',
      'local:find_repositories',
      'local:create_directory',
      'local:run_tests'
    ];

    mockConnectedAgents = [
      {
        deviceId,
        name: 'Local-Agent-win11',
        platform: 'windows',
        capabilities: liveCapabilities,
        status: 'online',
        connectedAt: Date.now()
      }
    ];

    const onlineStatus = await handlers.handleDeviceStatus(callerAdmin);
    assert.strictEqual(onlineStatus.totalOnline, 1);
    assert.strictEqual(onlineStatus.totalConnections, 1);
    const onlineDev = onlineStatus.devices.find((d: any) => d.deviceId === deviceId);
    assert.strictEqual(onlineDev?.status, 'online');
    assert.deepStrictEqual(onlineDev?.capabilities, liveCapabilities, 'Live connection capabilities must override stale DeviceRecord');
    assert.strictEqual(onlineDev?.connectionCount, 1);
    assert.strictEqual(onlineDev?.duplicateConnection, undefined);
    passed++;

    // 3. remote_task_submit eligibility preflight uses live capabilities
    // a. Submitting task with supported live capability (e.g. local:find_repositories) should NOT report NO_ELIGIBLE_DEVICE_CAPABILITY
    const submitAllowed = await handlers.handleRemoteTaskSubmit({
      backend: 'local',
      capability: 'local:find_repositories',
      payload: { projectId: 'astor-tuneup' }
    }, callerAdmin);

    assert.strictEqual(submitAllowed.status, 'queued');
    assert.strictEqual(submitAllowed.waitingForEligibleDevice, undefined);
    passed++;

    // b. Submitting task with unsupported capability (e.g. local:raw_shell when not enabled) should report NO_ELIGIBLE_DEVICE_CAPABILITY
    const submitUnsupported = await handlers.handleRemoteTaskSubmit({
      backend: 'local',
      capability: 'local:raw_shell',
      payload: { command: 'dir' }
    }, callerAdmin);

    assert.strictEqual(submitUnsupported.waitingForEligibleDevice, true);
    assert.strictEqual(submitUnsupported.reason, 'NO_ELIGIBLE_DEVICE_CAPABILITY');
    passed++;

    // 4. Duplicate same-device WebSocket connections: totalOnline is unique devices (1), totalConnections is sockets (2)
    mockConnectedAgents = [
      {
        deviceId,
        name: 'Local-Agent-win11',
        platform: 'windows',
        capabilities: liveCapabilities,
        status: 'online',
        connectedAt: Date.now()
      },
      {
        deviceId,
        name: 'Local-Agent-win11-dup',
        platform: 'windows',
        capabilities: liveCapabilities,
        status: 'online',
        connectedAt: Date.now() + 100
      }
    ];

    const duplicateStatus = await handlers.handleDeviceStatus(callerAdmin);
    assert.strictEqual(duplicateStatus.totalOnline, 1, 'totalOnline must count unique online devices');
    assert.strictEqual(duplicateStatus.totalConnections, 2, 'totalConnections must count total live sockets');
    const dupDev = duplicateStatus.devices.find((d: any) => d.deviceId === deviceId);
    assert.strictEqual(dupDev?.connectionCount, 2, 'Must report connectionCount = 2');
    assert.strictEqual(dupDev?.duplicateConnection, true, 'Must report duplicateConnection = true');
    passed++;

    // 5. Local TASK_FAIL protocol regression: Local Agent TASK_FAIL without retryable field defaults to retryable:false in Gateway
    const localFailTask = taskStore.createTask({
      backend: 'local',
      capability: 'local:write_file',
      payload: { path: 'out.txt', content: 'data' }
    });
    taskStore.claimTask(deviceId, ['local:write_file']);

    // Simulate Gateway TASK_FAIL message handling: msg.retryable ?? false
    const rawMsgWithoutRetryable = {
      type: 'TASK_FAIL',
      taskId: localFailTask.taskId,
      deviceId,
      error: { code: 'IO_ERROR', message: 'Disk full' }
    };
    taskStore.failTask(rawMsgWithoutRetryable.taskId, rawMsgWithoutRetryable.error, {
      retryable: (rawMsgWithoutRetryable as any).retryable ?? false
    });

    const failedLocalTask = taskStore.getTask(localFailTask.taskId);
    assert.strictEqual(failedLocalTask?.status, 'failed', 'Local TASK_FAIL without retryable flag must default to terminal failure');
    assert.ok(failedLocalTask?.completedAt, 'completedAt must be set on terminal failure');
    assert.strictEqual(failedLocalTask?.error?.code, 'IO_ERROR');
    assert.strictEqual(failedLocalTask?.retryPolicy.retryCount, 0, 'retryCount must not increment on terminal failure');
    passed++;

  } catch (err: any) {
    console.error('DeviceStatus Live Capabilities test failed:', err);
    failed++;
  }

  return { passed, failed };
}
