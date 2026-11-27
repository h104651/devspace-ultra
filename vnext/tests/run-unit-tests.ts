import { runAuthUnitTests } from './unit/auth.test';
import { runScopesUnitTests } from './unit/scopes.test';
import { runTaskStateUnitTests } from './unit/task-state.test';
import { runTaskAttemptMigrationTests } from './unit/task-attempt-migration.test';
import { runTaskLogRetentionUnitTests } from './unit/task-log-retention.test';
import { runRedactorUnitTests } from './unit/redactor.test';
import { runPathSanitizerUnitTests } from './unit/path-sanitizer.test';
import { runArtifactsUnitTests } from './unit/artifacts.test';
import { runProjectRegistryUnitTests } from './unit/project-registry.test';
import { runEnvironmentProbeUnitTests } from './unit/environment-probe.test';
import { runOfflineRunnerPlanTests } from './unit/offline-runner-plan.test';
import { runDeviceStatusLiveCapabilitiesUnitTests } from './unit/device-status-live-capabilities.test';
import { runLocalFastToolsBoundedResultTests } from './unit/local-fast-tools-bounded-result.test';
import { runInventoryTasksUnitTests } from './unit/inventory-tasks.test';
import { runWorkflowDeploymentGateTests } from './unit/workflow-deployment-gate.test';
import { runWindowsServiceStandardizationUnitTests } from './unit/windows-service-standardization.test';
import { runMcp2026Tests } from './mcp/mcp-2026.test';

async function main() {
  console.log('====================================================');
  console.log('       DevSpace Ultra — Unit Test Suite             ');
  console.log('====================================================\n');
  let totalPassed = 0;
  let totalFailed = 0;

  const suites = [
    { name: 'Unit: Auth & Token Management', runner: runAuthUnitTests },
    { name: 'Unit: Scopes & Permissions', runner: runScopesUnitTests },
    { name: 'Unit: Task State & Transitions', runner: runTaskStateUnitTests },
    { name: 'Unit: Legacy In-Flight Attempt Migration', runner: runTaskAttemptMigrationTests },
    { name: 'Unit: Bounded Task Log Retention', runner: runTaskLogRetentionUnitTests },
    { name: 'Unit: Secret & PII Redactor', runner: runRedactorUnitTests },
    { name: 'Unit: Path Sanitizer & Sandbox', runner: runPathSanitizerUnitTests },
    { name: 'Unit: Artifacts & Integrity', runner: runArtifactsUnitTests },
    { name: 'Unit: Local Project Registry & Path Security', runner: runProjectRegistryUnitTests },
    { name: 'Unit: Local Agent Environment Probe Capabilities', runner: runEnvironmentProbeUnitTests },
    { name: 'Unit: Offline Runner Profile Planner', runner: runOfflineRunnerPlanTests },
    { name: 'Unit: Device Status Live Capabilities & Eligibility', runner: runDeviceStatusLiveCapabilitiesUnitTests },
    { name: 'Unit: Local Fast Tools Bounded Direct Results', runner: runLocalFastToolsBoundedResultTests },
    { name: 'Unit: Read-Only Task Inventory & Preflight Verification', runner: runInventoryTasksUnitTests },
    { name: 'Unit: GitHub Actions Deployment Gate & Authorization', runner: runWorkflowDeploymentGateTests },
    { name: 'Unit: Windows Agent Service Standardization & Security', runner: runWindowsServiceStandardizationUnitTests },
    { name: 'Protocol: MCP 2026-07-28 Wire Validation', runner: runMcp2026Tests }
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
  console.log(`Total Unit Tests Passed: ${totalPassed}`);
  console.log(`Total Unit Tests Failed: ${totalFailed}`);
  console.log('====================================================');
  if (totalFailed > 0) process.exit(1);
  await new Promise(resolve => setTimeout(resolve, 300));
  process.exit(0);
}

main().catch(err => { console.error('Fatal error during unit tests:', err); process.exit(1); });
