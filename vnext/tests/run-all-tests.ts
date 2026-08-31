import { runAuthUnitTests } from './unit/auth.test';
import { runScopesUnitTests } from './unit/scopes.test';
import { runTaskStateUnitTests } from './unit/task-state.test';
import { runRedactorUnitTests } from './unit/redactor.test';
import { runPathSanitizerUnitTests } from './unit/path-sanitizer.test';
import { runArtifactsUnitTests } from './unit/artifacts.test';
import { runProjectRegistryUnitTests } from './unit/project-registry.test';
import { runEnvironmentProbeUnitTests } from './unit/environment-probe.test';
import { runDeviceStatusLiveCapabilitiesUnitTests } from './unit/device-status-live-capabilities.test';
import { runGatewayFlowIntegrationTests } from './integration/gateway-flow.test';
import { runKaggleIntegrationTests } from './integration/kaggle-mock.test';
import { runSwarmIntegrationTests } from './integration/swarm.test';
import { runStaleRecoveryIntegrationTests } from './integration/stale-recovery.test';
import { runIdempotencyIntegrationTests } from './integration/idempotency.test';
import { runRemoteMcpHttpTests } from './integration/remote-mcp-http.test';
import { runAgentLifecycleDurabilityTests } from './integration/agent-lifecycle-durability.test';
import { runLocalProjectRoutingIntegrationTests } from './integration/local-project-routing.test';
import { runLocalWorkspaceDiscoveryIntegrationTests } from './integration/local-workspace-discovery.test';
import { runSecurityTests } from './security/security.test';
import { runBootstrapTokenSecurityTests } from './security/bootstrap-token-security.test';
import { runWorkersRuntimeTests } from './cloudflare/workers-runtime.test';
import { runChatSwarmBrowserE2ETests } from './cloudflare/chat-swarm-browser-e2e.test';
import { runR2CostGuardTests } from './cloudflare/r2-cost-guard.test';
import { runOAuthTests } from './oauth/oauth.test';
import { runMcp2026Tests } from './mcp/mcp-2026.test';
import { runKaggleProjectTests } from './integration/kaggle-project.test';
import { runKaggleWorkspaceTests } from './integration/kaggle-workspace.test';

async function main() {
  console.log('====================================================');
  console.log('       DevSpace Ultra — Automated Test Suite        ');
  console.log('====================================================\n');
  let totalPassed = 0;
  let totalFailed = 0;

  const suites: Array<{ name: string; runner: () => Promise<{ passed: number; failed: number }> }> = [
    { name: 'Unit: Auth & Token Management', runner: runAuthUnitTests },
    { name: 'Unit: Scopes & Permissions', runner: runScopesUnitTests },
    { name: 'Unit: Task State & Transitions', runner: runTaskStateUnitTests },
    { name: 'Unit: Secret & PII Redactor', runner: runRedactorUnitTests },
    { name: 'Unit: Path Sanitizer & Sandbox', runner: runPathSanitizerUnitTests },
    { name: 'Unit: Artifacts & Integrity', runner: runArtifactsUnitTests },
    { name: 'Unit: Local Project Registry & Path Security', runner: runProjectRegistryUnitTests },
    { name: 'Unit: Local Agent Environment Probe Capabilities', runner: runEnvironmentProbeUnitTests },
    { name: 'Unit: Device Status Live Capabilities & Eligibility', runner: runDeviceStatusLiveCapabilitiesUnitTests },
    { name: 'Protocol: MCP 2026-07-28 Wire Validation', runner: runMcp2026Tests },
    { name: 'Integration: Gateway Flow (REST + WS Agent)', runner: runGatewayFlowIntegrationTests },
    { name: 'Integration: Remote MCP Transport (HTTP POST /mcp)', runner: runRemoteMcpHttpTests },
    { name: 'Integration: Agent Lifecycle & Durability', runner: runAgentLifecycleDurabilityTests },
    { name: 'Integration: Local Multi-Project Named Routing', runner: runLocalProjectRoutingIntegrationTests },
    { name: 'Integration: Local Workspace Discovery & Nested Operations', runner: runLocalWorkspaceDiscoveryIntegrationTests },
    { name: 'Integration: Kaggle Mock Backend', runner: runKaggleIntegrationTests },
    { name: 'Integration: Kaggle Persistent Project Control v1', runner: runKaggleProjectTests },
    { name: 'Integration: Kaggle Large Project Workspace Mode', runner: runKaggleWorkspaceTests },
    { name: 'Integration: Chat Swarm & Wake Bridge', runner: runSwarmIntegrationTests },
    { name: 'Integration: Stale Task Recovery', runner: runStaleRecoveryIntegrationTests },
    { name: 'Integration: Idempotency & Replays', runner: runIdempotencyIntegrationTests },
    { name: 'Cloudflare: Workers Runtime & SQLite DO & R2 Adapter', runner: runWorkersRuntimeTests },
    { name: 'Cloudflare: R2 Cost Guard & Hard Quota Limits', runner: runR2CostGuardTests },
    { name: 'Cloudflare: Browser Swarm E2E & DO Restart', runner: runChatSwarmBrowserE2ETests },
    { name: 'Cloudflare: OAuth 2.1 & Protected Resource Metadata', runner: runOAuthTests },
    { name: 'Security: Zero Trust, Injections, Shell & Rate Limits', runner: runSecurityTests },
    { name: 'Security: Bootstrap Token Security & Redaction', runner: runBootstrapTokenSecurityTests }
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
  console.log(`Total Tests Passed: ${totalPassed}`);
  console.log(`Total Tests Failed: ${totalFailed}`);
  console.log('====================================================');
  if (totalFailed > 0) process.exit(1);
  console.log('\x1b[32mAll test suites passed successfully!\x1b[0m\n');
  process.exit(0);
}

main().catch(err => { console.error('Fatal error during test run:', err); process.exit(1); });
