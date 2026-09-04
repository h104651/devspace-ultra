import * as assert from 'assert';
import * as fs from 'fs';
import { SwarmOrchestrator } from '../../src/swarm/swarm-orchestrator';
import { WakeBridge } from '../../src/swarm/wake-bridge';
import { TaskStore } from '../../src/storage/task-store';

export async function runSwarmIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-swarm';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  try {
    const taskStore = new TaskStore(testDir);
    const wakeBridge = new WakeBridge();
    const swarm = new SwarmOrchestrator(taskStore, wakeBridge);

    // Test 1: Worker registration
    const worker1 = swarm.registerWorker('Researcher-1', 'research');
    const worker2 = swarm.registerWorker('Coder-1', 'coding');
    assert.strictEqual(swarm.listWorkers().length, 2);
    passed++;

    // Test 2: Task dispatch to specific role
    const dispatch = swarm.dispatchTask({
      roleRequired: 'coding',
      taskTitle: 'Implement feature X',
      prompt: 'Write code for feature X'
    });

    assert.ok(dispatch.taskId);
    assert.strictEqual(dispatch.assignedWorkerId, worker2.workerId, 'Should assign to Coder-1');
    assert.strictEqual(worker2.status, 'busy');
    passed++;

    // Test 3: Acknowledge and Complete Task
    const ack = swarm.acknowledgeTask(worker2.workerId, dispatch.taskId);
    assert.strictEqual(ack, true);

    const completed = swarm.completeWorkerTask(worker2.workerId, dispatch.taskId, { code: 'console.log(1)' });
    assert.strictEqual(completed, true);
    assert.strictEqual(worker2.status, 'idle');
    assert.strictEqual(worker2.totalTasksCompleted, 1);
    passed++;

    // Test 4: Wake bridge event reception
    const events = wakeBridge.getRecentEvents();
    assert.ok(events.length >= 3, 'Wake bridge should record events');
    passed++;
  } catch (err: any) {
    console.error('Swarm integration test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
