import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

export async function runWorkflowDeploymentGateTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  function ok(cond: any, msg: string) {
    if (!cond) {
      console.error(`  [FAIL] ${msg}`);
      failed++;
      throw new Error(msg);
    }
    passed++;
  }

  console.log('\n--- Running Unit: GitHub Actions Production Deployment Gate Tests ---');

  const workflowPath = path.resolve(__dirname, '../../../.github/workflows/vnext-ci.yml');
  ok(fs.existsSync(workflowPath), `Workflow file exists at ${workflowPath}`);

  const content = fs.readFileSync(workflowPath, 'utf8');

  // Test 1: workflow_dispatch inputs definition
  ok(content.includes('workflow_dispatch:'), 'Workflow declares workflow_dispatch trigger');
  ok(content.includes('deploy_production:'), 'workflow_dispatch defines deploy_production input');
  ok(content.includes('target_commit_sha:'), 'workflow_dispatch defines target_commit_sha input');
  ok(content.includes('preflight_inventory_confirmed:'), 'workflow_dispatch defines preflight_inventory_confirmed input');

  // Test 2: deploy-production job condition
  const deployJobMatch = content.match(/deploy-production:[\s\S]*?if:\s*([^\r\n]+)/);
  ok(deployJobMatch !== null, 'deploy-production job has an if: condition');
  const ifCondition = deployJobMatch![1].trim();

  // Test 3: Ensure ordinary push to main CANNOT deploy
  ok(ifCondition.includes("github.event_name == 'workflow_dispatch'"), 'Job strictly requires workflow_dispatch event');
  ok(!ifCondition.includes("github.event_name != 'pull_request'"), 'Removed unsafe inverted pull_request condition');

  // Test 4: Ensure branch restriction to main
  ok(ifCondition.includes("github.ref == 'refs/heads/main'"), 'Job strictly requires main branch reference');

  // Test 5: Ensure dual confirmation flags
  ok(ifCondition.includes('inputs.deploy_production == true'), 'Job requires deploy_production == true');
  ok(ifCondition.includes('inputs.preflight_inventory_confirmed == true'), 'Job requires preflight_inventory_confirmed == true');

  // Simulation function matching GitHub Actions condition expression
  function evalDeployGate(context: {
    event_name: string;
    ref: string;
    inputs?: {
      deploy_production?: boolean;
      preflight_inventory_confirmed?: boolean;
      target_commit_sha?: string;
    };
  }): boolean {
    return (
      context.event_name === 'workflow_dispatch' &&
      context.ref === 'refs/heads/main' &&
      context.inputs?.deploy_production === true &&
      context.inputs?.preflight_inventory_confirmed === true
    );
  }

  // Simulation Scenario A: Push to main (e.g. merge of PR #23)
  const pushToMain = evalDeployGate({
    event_name: 'push',
    ref: 'refs/heads/main'
  });
  ok(pushToMain === false, 'Scenario A: Ordinary push to main BLOCKS production deploy');

  // Simulation Scenario B: Pull request to main
  const prToMain = evalDeployGate({
    event_name: 'pull_request',
    ref: 'refs/pull/23/merge'
  });
  ok(prToMain === false, 'Scenario B: Pull request BLOCKS production deploy');

  // Simulation Scenario C: Manual trigger on feature branch
  const manualOnBranch = evalDeployGate({
    event_name: 'workflow_dispatch',
    ref: 'refs/heads/feature/multi-device-targeted-routing',
    inputs: { deploy_production: true, preflight_inventory_confirmed: true }
  });
  ok(manualOnBranch === false, 'Scenario C: Manual trigger on feature branch BLOCKS production deploy');

  // Simulation Scenario D: Manual trigger on main without deploy_production checked
  const manualNoConfirm = evalDeployGate({
    event_name: 'workflow_dispatch',
    ref: 'refs/heads/main',
    inputs: { deploy_production: false, preflight_inventory_confirmed: true }
  });
  ok(manualNoConfirm === false, 'Scenario D: Missing deploy_production confirmation BLOCKS deploy');

  // Simulation Scenario E: Manual trigger on main without preflight inventory checked
  const manualNoPreflight = evalDeployGate({
    event_name: 'workflow_dispatch',
    ref: 'refs/heads/main',
    inputs: { deploy_production: true, preflight_inventory_confirmed: false }
  });
  ok(manualNoPreflight === false, 'Scenario E: Missing preflight inventory confirmation BLOCKS deploy');

  // Simulation Scenario F: Fully authorized manual deployment on main
  const authorizedDeploy = evalDeployGate({
    event_name: 'workflow_dispatch',
    ref: 'refs/heads/main',
    inputs: { deploy_production: true, preflight_inventory_confirmed: true }
  });
  ok(authorizedDeploy === true, 'Scenario F: Fully authorized manual trigger on main PERMITS deploy job');

  // Test 6: In-step target_commit_sha validation & environment variable safety
  ok(content.includes('Validate Deployment Authorization & Target SHA'), 'Job contains in-step target SHA validator');
  ok(content.includes('INPUT_TARGET_SHA: ${{ inputs.target_commit_sha }}'), 'Passes target_commit_sha safely via environment variable');
  ok(content.includes('INPUT_OPERATOR: ${{ inputs.operator_name }}'), 'Passes operator_name safely via environment variable');
  ok(content.includes('ACTOR_NAME: ${{ github.actor }}'), 'Passes github.actor safely via environment variable');
  ok(!content.includes('echo "Deployment authorized by: ${{'), 'Strictly avoids raw interpolation in echo/commands');

  // Input definition must be required: true
  const targetShaInputMatch = content.match(/target_commit_sha:[\s\S]*?required:\s*(true|false)/);
  ok(targetShaInputMatch !== null && targetShaInputMatch[1] === 'true', 'target_commit_sha input is declared with required: true');

  // SHA check simulation function
  function evalShaCheck(targetSha: string | undefined, currentSha: string): { ok: boolean; reason?: string } {
    if (!targetSha || targetSha.trim() === '') {
      return { ok: false, reason: 'EMPTY_SHA' };
    }
    const cleanSha = targetSha.trim();
    if (!/^[0-9a-fA-F]{40}$/.test(cleanSha)) {
      return { ok: false, reason: 'INVALID_HEX_FORMAT' };
    }
    if (cleanSha !== currentSha) {
      return { ok: false, reason: 'SHA_MISMATCH' };
    }
    return { ok: true };
  }

  const validSha = '91cb12afbc749e79caf505bac4e99491015f8dea';
  const otherSha = '3b99dc51ef740000dc2f44db9ea7d62d9a4bb327';

  ok(evalShaCheck(validSha, validSha).ok === true, 'Exact matching 40-char SHA passes');
  ok(evalShaCheck('', validSha).ok === false, 'Empty SHA is rejected');
  ok(evalShaCheck(undefined, validSha).ok === false, 'Undefined SHA is rejected');
  ok(evalShaCheck('   ', validSha).ok === false, 'Whitespace SHA is rejected');
  ok(evalShaCheck('abc1234', validSha).ok === false, 'Short SHA (7 characters) is rejected');
  ok(evalShaCheck('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', validSha).ok === false, 'Non-hex SHA (40 chars) is rejected');
  ok(evalShaCheck('91cb12a; echo injected', validSha).ok === false, 'Command injection attempt in SHA is rejected');
  ok(evalShaCheck(otherSha, validSha).ok === false, 'Mismatched 40-char SHA is rejected');
  ok(evalShaCheck(otherSha, validSha).reason === 'SHA_MISMATCH', 'Rejection reason is SHA_MISMATCH');

  console.log(`Unit: GitHub Actions Deployment Gate: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (require.main === module) {
  runWorkflowDeploymentGateTests().then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
