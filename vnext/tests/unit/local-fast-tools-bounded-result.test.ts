import * as assert from 'assert';
import { AuthManager } from '../../src/security/auth-manager';
import { McpHandlers } from '../../src/mcp/handlers';
import { TaskStore } from '../../src/storage/task-store';
import { TaskRouter } from '../../src/gateway/task-router';
import { IdempotencyStore } from '../../src/storage/idempotency-store';
import { KillSwitch } from '../../src/security/kill-switch';
import { AuditLogger } from '../../src/security/audit-logger';

export async function runLocalFastToolsBoundedResultTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    const masterSecret = '01234567890123456789012345678901';
    const authManager = new AuthManager(masterSecret);
    const killSwitch = new KillSwitch();
    const auditLogger = new AuditLogger();
    const taskStore = new TaskStore();
    const idempotencyStore = new IdempotencyStore();

    const deviceId = 'test-device-bounded';
    authManager.registerDevice(deviceId, 'windows', [
      'local:read',
      'local:write',
      'local:git_status'
    ]);

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
      'local:create_directory'
    ];

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
    const callerAdmin = {
      scopes: ['admin', 'local:read', 'local:write', 'tasks:submit', 'tasks:read', 'local:exec', 'local:test'],
      subjectId: 'admin-caller'
    };

    // 1. Zero live agent: returns immediately without waiting
    mockConnectedAgents = [];
    const zeroAgentRes = await handlers.handleLocalFindRepositories({ projectId: 'astor-tuneup' }, callerAdmin);
    assert.strictEqual(zeroAgentRes.status, 'queued');
    assert.strictEqual(zeroAgentRes.pending, true);
    assert.strictEqual(zeroAgentRes.waitingForEligibleDevice, true);
    assert.strictEqual(zeroAgentRes.reason, 'NO_ONLINE_DEVICE');
    passed++;

    // 2. Live agent without required capability: returns immediately without waiting
    mockConnectedAgents = [
      {
        deviceId,
        name: 'Agent-Limited',
        platform: 'windows',
        capabilities: ['local:read_file'],
        status: 'online',
        connectedAt: Date.now()
      }
    ];
    const ineligibleRes = await handlers.handleLocalFindRepositories({ projectId: 'astor-tuneup' }, callerAdmin);
    assert.strictEqual(ineligibleRes.status, 'queued');
    assert.strictEqual(ineligibleRes.pending, true);
    assert.strictEqual(ineligibleRes.waitingForEligibleDevice, true);
    assert.strictEqual(ineligibleRes.reason, 'NO_ELIGIBLE_DEVICE_CAPABILITY');
    passed++;

    // Set full live capabilities
    mockConnectedAgents = [
      {
        deviceId,
        name: 'Agent-Full',
        platform: 'windows',
        capabilities: liveCapabilities,
        status: 'online',
        connectedAt: Date.now()
      }
    ];

    // 3. Fast Local succeeded task: bounded wait returns terminal result directly
    // Simulate background agent claiming and succeeding task quickly (after 50ms)
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.capability === 'local:find_repositories') {
          taskStore.completeTask(claimed.taskId, {
            repositories: [
              { repoRelativePath: 'astor_tuneup', branch: 'main', projectTypes: ['flutter'] }
            ]
          });
        }
      }
    }, 50);

    const directSuccessRes = await handlers.handleLocalFindRepositories({
      projectId: 'astor-tuneup',
      waitMs: 2000
    }, callerAdmin);

    assert.strictEqual(directSuccessRes.status, 'succeeded');
    assert.strictEqual(directSuccessRes.directResult, true);
    assert.ok(directSuccessRes.completedAt);
    assert.deepStrictEqual(directSuccessRes.result.repositories[0].repoRelativePath, 'astor_tuneup');
    passed++;

    // 4. Fast Local failed task: bounded wait returns terminal failure directly
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.capability === 'local:read_file') {
          taskStore.failTask(claimed.taskId, { code: 'FILE_NOT_FOUND', message: 'File missing' }, { retryable: false });
        }
      }
    }, 50);

    const directFailRes = await handlers.handleLocalReadFile({
      projectId: 'astor-tuneup',
      relativePath: 'missing.txt',
      waitMs: 2000
    }, callerAdmin);

    assert.strictEqual(directFailRes.status, 'failed');
    assert.strictEqual(directFailRes.directResult, true);
    assert.ok(directFailRes.completedAt);
    assert.strictEqual(directFailRes.error.code, 'FILE_NOT_FOUND');
    passed++;

    // 5. Eligible but slow task: bounded wait expires without cancelling durable task
    const slowRes = await handlers.handleLocalFindFiles({
      projectId: 'astor-tuneup',
      pattern: '*.dart',
      waitMs: 150
    }, callerAdmin);

    assert.strictEqual(slowRes.pending, true);
    assert.strictEqual(slowRes.directResult, false);
    assert.strictEqual(slowRes.status, 'queued');
    const durableTask = taskStore.getTask(slowRes.taskId);
    assert.ok(durableTask, 'Durable task must remain intact');
    assert.strictEqual(durableTask?.status, 'queued', 'Task must NOT be cancelled on timeout');
    passed++;

    // 6. Idempotency: replay does not create a duplicate task and returns terminal result
    const clientReqId = 'req-idem-123';
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.clientRequestId === clientReqId) {
          taskStore.completeTask(claimed.taskId, { status: 'healthy', branch: 'main' });
        }
      }
    }, 50);

    const firstCall = await handlers.handleLocalProjectStatus({
      projectId: 'astor-tuneup',
      clientRequestId: clientReqId,
      waitMs: 2000
    }, callerAdmin);
    assert.strictEqual(firstCall.status, 'succeeded');
    assert.strictEqual(firstCall.directResult, true);

    const replayCall = await handlers.handleLocalProjectStatus({
      projectId: 'astor-tuneup',
      clientRequestId: clientReqId,
      waitMs: 2000
    }, callerAdmin);
    assert.strictEqual(replayCall.taskId, firstCall.taskId, 'Replay must return same taskId');
    assert.strictEqual(replayCall.status, 'succeeded');
    assert.strictEqual(replayCall.directResult, true);
    passed++;

    // 7. Direct result across all fast local tools:
    // a. local_find_files
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.capability === 'local:find_files') {
          taskStore.completeTask(claimed.taskId, { files: [{ relativePath: 'pubspec.yaml' }] });
        }
      }
    }, 50);
    const findFilesRes = await handlers.handleLocalFindFiles({ projectId: 'astor-tuneup', waitMs: 1000 }, callerAdmin);
    assert.strictEqual(findFilesRes.status, 'succeeded');
    assert.strictEqual(findFilesRes.directResult, true);
    assert.strictEqual(findFilesRes.result.files[0].relativePath, 'pubspec.yaml');
    passed++;

    // b. local_search_text
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.capability === 'local:search_text') {
          taskStore.completeTask(claimed.taskId, { matches: [{ relativePath: 'lib/main.dart', lineNumber: 1 }] });
        }
      }
    }, 50);
    const searchTextRes = await handlers.handleLocalSearchText({ projectId: 'astor-tuneup', query: 'main', waitMs: 1000 }, callerAdmin);
    assert.strictEqual(searchTextRes.status, 'succeeded');
    assert.strictEqual(searchTextRes.directResult, true);
    passed++;

    // c. local_git_status
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.capability === 'local:git_status') {
          taskStore.completeTask(claimed.taskId, { branch: 'feature/v1.8.0', isClean: true });
        }
      }
    }, 50);
    const gitStatusRes = await handlers.handleLocalGitStatus({ projectId: 'astor-tuneup', waitMs: 1000 }, callerAdmin);
    assert.strictEqual(gitStatusRes.status, 'succeeded');
    assert.strictEqual(gitStatusRes.directResult, true);
    assert.strictEqual(gitStatusRes.result.branch, 'feature/v1.8.0');
    passed++;

    // d. local_project_list
    setTimeout(() => {
      let claimed: any;
      while ((claimed = taskStore.claimTask(deviceId, liveCapabilities))) {
        if (claimed.capability === 'local:list_projects') {
          taskStore.completeTask(claimed.taskId, { projects: [{ projectId: 'astor-tuneup' }] });
        }
      }
    }, 50);
    const projectListRes = await handlers.handleLocalProjectList({ waitMs: 1000 }, callerAdmin);
    assert.strictEqual(projectListRes.status, 'succeeded');
    assert.strictEqual(projectListRes.directResult, true);
    passed++;

    // 8. Async tools remain asynchronous without bounded wait:
    // a. local_run_tests
    const runTestsRes = await handlers.handleLocalRunTests({ projectId: 'astor-tuneup' }, callerAdmin);
    assert.strictEqual(runTestsRes.status, 'queued');
    assert.strictEqual((runTestsRes as any).directResult, undefined, 'local_run_tests must remain async');
    passed++;

    // b. local_build_project
    const buildProjectRes = await handlers.handleLocalBuildProject({ projectId: 'astor-tuneup' }, callerAdmin);
    assert.strictEqual(buildProjectRes.status, 'queued');
    assert.strictEqual((buildProjectRes as any).directResult, undefined, 'local_build_project must remain async');
    passed++;

    // c. remote_task_submit
    const remoteSubmitRes = await handlers.handleRemoteTaskSubmit({
      backend: 'local',
      capability: 'local:git_status',
      payload: { projectId: 'astor-tuneup' }
    }, callerAdmin);
    assert.strictEqual(remoteSubmitRes.status, 'queued');
    assert.strictEqual((remoteSubmitRes as any).directResult, undefined, 'remote_task_submit must remain async');
    passed++;

  } catch (err: any) {
    console.error('Local Fast Tools Bounded Result test failed:', err);
    failed++;
  }

  return { passed, failed };
}
