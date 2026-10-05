import * as assert from 'assert';
import * as fs from 'fs';
import { GatewayServer } from '../../src/gateway/server';

export async function runIdempotencyIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-idemp';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const server = new GatewayServer({
    storageDir: testDir,
    masterSecret: 'test-secret',
    kaggleMockMode: true
  });

  try {
    const clientRequestId = 'req-unique-id-998877';

    // 1. First submission
    const res1 = await server.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: 'local:read',
        payload: { file: 'test.txt' },
        clientRequestId
      },
      ['admin'],
      'client-1'
    );

    assert.strictEqual(res1.isReplay, false);
    passed++;

    // 2. Second submission with SAME clientRequestId
    const res2 = await server.taskRouter.routeTaskSubmit(
      {
        backend: 'local',
        capability: 'local:read',
        payload: { file: 'test.txt' },
        clientRequestId
      },
      ['admin'],
      'client-1'
    );

    assert.strictEqual(res2.isReplay, true, 'Second submit must be flagged as replay');
    assert.strictEqual(res2.taskId, res1.taskId, 'Should return identical taskId');
    passed++;

    // 3. Verify total tasks count in TaskStore is exactly 1 (no duplicate task created)
    const allTasks = server.taskStore.listTasks();
    assert.strictEqual(allTasks.length, 1, 'Only one durable task should be stored');
    passed++;
  } catch (err: any) {
    console.error('Idempotency test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
