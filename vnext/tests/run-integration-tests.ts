import { runGatewayFlowIntegrationTests } from './integration/gateway-flow.test';
import { runKaggleIntegrationTests } from './integration/kaggle-mock.test';
import { runKaggleLegacyRecoveryTests } from './integration/kaggle-legacy-recovery.test';
import { runSwarmIntegrationTests } from './integration/swarm.test';
import { runStaleRecoveryIntegrationTests } from './integration/stale-recovery.test';
import { runIdempotencyIntegrationTests } from './integration/idempotency.test';
import { runRemoteMcpHttpTests } from './integration/remote-mcp-http.test';
import { runAgentLifecycleDurabilityTests } from './integration/agent-lifecycle-durability.test';
import { runLocalProjectRoutingIntegrationTests } from './integration/local-project-routing.test';
import { runLocalWorkspaceDiscoveryIntegrationTests } from './integration/local-workspace-discovery.test';
import { runMultiDeviceRoutingTests } from './integration/multi-device-routing.test';
import { runKaggleProjectTests } from './integration/kaggle-project.test';
import { runKaggleWorkspaceTests } from './integration/kaggle-workspace.test';
import { runKaggleDatasetFileTests } from './integration/kaggle-dataset-file.test';
import { runKaggleDurableReconciliationTests } from './integration/kaggle-durable-reconciliation.test';
import { runConnectionLifecycleFencingTests } from './integration/connection-lifecycle-fencing.test';
import { runWorkersRuntimeTests } from './cloudflare/workers-runtime.test';
import { runWorkerRoutingRecoveryTests } from './cloudflare/worker-routing-recovery.test';
import { runRemoteTaskWaitProductionTests } from './cloudflare/remote-task-wait-production.test';
import { runTaskDurablePersistenceTests } from './cloudflare/task-durable-persistence.test';
import { runChatSwarmBrowserE2ETests } from './cloudflare/chat-swarm-browser-e2e.test';
import { runChatSwarmStorageEfficiencyTests } from './cloudflare/chat-swarm-storage-efficiency.test';
import { runColdStartStorageEfficiencyTests } from './cloudflare/cold-start-storage-efficiency.test';
import { runR2CostGuardTests } from './cloudflare/r2-cost-guard.test';

async function main() {
  console.log('====================================================');
  console.log('    DevSpace Ultra — Integration Test Suite         ');
  console.log('====================================================\n');
  let totalPassed = 0;
  let totalFailed = 0;

  const suites = [
    { name: 'Integration: Gateway Flow (REST + WS Agent)', runner: runGatewayFlowIntegrationTests },
    { name: 'Integration: Remote MCP Transport (HTTP POST /mcp)', runner: runRemoteMcpHttpTests },
    { name: 'Integration: Agent Lifecycle & Durability', runner: runAgentLifecycleDurabilityTests },
    { name: 'Integration: Local Multi-Project Named Routing', runner: runLocalProjectRoutingIntegrationTests },
    { name: 'Integration: Multi-Device Targeted Routing & Registration', runner: runMultiDeviceRoutingTests },
    { name: 'Integration: Local Workspace Discovery & Nested Operations', runner: runLocalWorkspaceDiscoveryIntegrationTests },
    { name: 'Integration: Kaggle Mock Backend', runner: runKaggleIntegrationTests },
    { name: 'Integration: Pre-Migration Kaggle Restart Recovery', runner: runKaggleLegacyRecoveryTests },
    { name: 'Integration: Kaggle Persistent Project Control v1', runner: runKaggleProjectTests },
    { name: 'Integration: Kaggle Large Project Workspace Mode', runner: runKaggleWorkspaceTests },
    { name: 'Integration: Kaggle Dataset File Direct Read', runner: runKaggleDatasetFileTests },
    { name: 'Integration: Kaggle Durable Persistence & Cold-Start Reconcile', runner: runKaggleDurableReconciliationTests },
    { name: 'Integration: Chat Swarm & Wake Bridge', runner: runSwarmIntegrationTests },
    { name: 'Integration: Stale Task Recovery', runner: runStaleRecoveryIntegrationTests },
    { name: 'Integration: Idempotency & Replays', runner: runIdempotencyIntegrationTests },
    { name: 'Integration: Connection Lifecycle & Fencing (T01-T24)', runner: runConnectionLifecycleFencingTests },
    { name: 'Cloudflare: Workers Runtime & SQLite DO & R2 Adapter', runner: runWorkersRuntimeTests },
    { name: 'Cloudflare: Non-destructive Recovery Singleton Routing', runner: runWorkerRoutingRecoveryTests },
    { name: 'Cloudflare: Production remote_task_wait MCP Surface', runner: runRemoteTaskWaitProductionTests },
    { name: 'Cloudflare: Durable Task Execution Metadata Persistence', runner: runTaskDurablePersistenceTests },
    { name: 'Cloudflare: R2 Cost Guard & Hard Quota Limits', runner: runR2CostGuardTests },
    { name: 'Cloudflare: Browser Swarm E2E & DO Restart', runner: runChatSwarmBrowserE2ETests },
    { name: 'Cloudflare: Chat Swarm Durable Storage Efficiency', runner: runChatSwarmStorageEfficiencyTests },
    { name: 'Cloudflare: Cold-Start Storage Efficiency & Lazy History', runner: runColdStartStorageEfficiencyTests }
  ];

  for (const suite of suites) {
    const startTime = Date.now();
    process.stdout.write(`▶ Running ${suite.name.padEnd(55)} `);
    try {
      const result = await suite.runner();
      const duration = Date.now() - startTime;
      totalPassed += result.passed;
      totalFailed += result.failed;
      console.log(result.failed === 0 ? `\x1b[32mPASS\x1b[0m (${result.passed} tests, ${duration}ms)` : `\x1b[31mFAIL\x1b[0m (${result.passed} passed, ${result.failed} failed, ${duration}ms)`);
    } catch (err: any) {
      totalFailed++;
      console.log(`\x1b[31mERROR\x1b[0m: ${err.message}`);
    }
  }

  console.log('\n====================================================');
  console.log(`Total Integration Tests Passed: ${totalPassed}`);
  console.log(`Total Integration Tests Failed: ${totalFailed}`);
  console.log('====================================================');
  if (totalFailed > 0) process.exit(1);
  await new Promise(resolve => setTimeout(resolve, 300));
  process.exit(0);
}

main().catch(err => { console.error('Fatal error during integration tests:', err); process.exit(1); });
