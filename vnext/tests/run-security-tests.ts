import { runSecurityTests } from './security/security.test';
import { runBootstrapTokenSecurityTests } from './security/bootstrap-token-security.test';
import { runMcpInsufficientScopeTests } from './cloudflare/mcp-insufficient-scope.test';
import { runOAuthTests } from './oauth/oauth.test';

async function main() {
  console.log('====================================================');
  console.log('       DevSpace Ultra — Security Test Suite         ');
  console.log('====================================================\n');
  let totalPassed = 0;
  let totalFailed = 0;

  const suites = [
    { name: 'Security: Zero Trust, Injections, Shell & Rate Limits', runner: runSecurityTests },
    { name: 'Security: Bootstrap Token Security & Redaction', runner: runBootstrapTokenSecurityTests },
    { name: 'Cloudflare: MCP OAuth Insufficient-Scope Step-Up', runner: runMcpInsufficientScopeTests },
    { name: 'Cloudflare: OAuth 2.1 & Protected Resource Metadata', runner: runOAuthTests }
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
  console.log(`Total Security Tests Passed: ${totalPassed}`);
  console.log(`Total Security Tests Failed: ${totalFailed}`);
  console.log('====================================================');
  if (totalFailed > 0) process.exit(1);
  await new Promise(resolve => setTimeout(resolve, 300));
  process.exit(0);
}

main().catch(err => { console.error('Fatal error during security tests:', err); process.exit(1); });
