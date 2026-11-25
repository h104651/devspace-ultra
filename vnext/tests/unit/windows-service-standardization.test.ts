import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  AGENT_EXIT_CODES,
  NON_RETRYABLE_EXIT_CODES,
  buildSanitizedAgentEnv,
  classifyAgentExitCode,
  redactSensitiveLogLine,
  stripSensitiveEnvInPlace
} from '../../src/local-agent/service-exit-codes';

export async function runWindowsServiceStandardizationUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  // 1. Exit code classifications & non-retryable fail-closed set
  try {
    assert.strictEqual(AGENT_EXIT_CODES.CLEAN, 0);
    assert.strictEqual(AGENT_EXIT_CODES.TRANSIENT_FAILURE, 1);
    assert.strictEqual(AGENT_EXIT_CODES.CONFIG_ERROR, 10);
    assert.strictEqual(AGENT_EXIT_CODES.LOCK_CONFLICT, 11);
    assert.strictEqual(AGENT_EXIT_CODES.POLICY_REJECTED, 12);
    assert.strictEqual(AGENT_EXIT_CODES.SHUTDOWN_TIMEOUT, 13);

    for (const code of [0, 10, 11, 12, 13]) {
      assert.strictEqual(NON_RETRYABLE_EXIT_CODES.has(code), true, `Exit code ${code} must be non-retryable`);
    }
    assert.strictEqual(NON_RETRYABLE_EXIT_CODES.has(1), false);
    assert.strictEqual(classifyAgentExitCode(11), 'LOCK_CONFLICT');
    assert.strictEqual(classifyAgentExitCode(12), 'POLICY_REJECTED');
    assert.strictEqual(classifyAgentExitCode(13), 'SHUTDOWN_TIMEOUT_LOCK_RETAINED');
    assert.strictEqual(classifyAgentExitCode(1), 'TRANSIENT_FAILURE');
    passed++;
  } catch (err) {
    console.error('Service exit code test failed:', err);
    failed++;
  }

  // 2. Least-privilege environment allowlist & sensitive env stripping
  try {
    const res = buildSanitizedAgentEnv(
      {
        PATH: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\isolated',
        TEMP: 'C:\\Temp',
        ADMIN_SECRET: 'super-admin-secret-value',
        MASTER_SECRET: 'super-master-secret-value',
        CLIENT_TOKEN: 'dsu_client_abc.def',
        ARBITRARY_CUSTOM_ENV: 'should-not-leak'
      },
      {
        GATEWAY_URL: 'wss://example.invalid/ws/agent',
        AGENT_ID: 'test-device',
        AGENT_NAME: 'Display-Node-1',
        AGENT_TOKEN: 'dsu_device_xyz.123',
        ALLOW_RAW_SHELL: 'false',
        MASTER_SECRET: 'file-master-secret',
        ADMIN_SECRET: 'file-admin-secret'
      }
    );

    assert.strictEqual(res.env.PATH, 'C:\\Windows\\System32');
    assert.strictEqual(res.env.USERPROFILE, 'C:\\Users\\isolated');
    assert.strictEqual(res.env.TEMP, 'C:\\Temp');
    assert.strictEqual(res.env.AGENT_ID, 'test-device');
    assert.strictEqual(res.env.AGENT_NAME, 'Display-Node-1');
    assert.strictEqual(res.env.AGENT_TOKEN, 'dsu_device_xyz.123');
    assert.strictEqual(res.env.ALLOW_RAW_SHELL, 'false');

    assert.strictEqual(res.env.ADMIN_SECRET, undefined);
    assert.strictEqual(res.env.MASTER_SECRET, undefined);
    assert.strictEqual(res.env.CLIENT_TOKEN, undefined);
    assert.strictEqual(res.env.ARBITRARY_CUSTOM_ENV, undefined);
    assert.ok(res.strippedSensitiveKeys.includes('ADMIN_SECRET'));
    assert.ok(res.strippedSensitiveKeys.includes('MASTER_SECRET'));
    assert.ok(res.strippedSensitiveKeys.includes('CLIENT_TOKEN'));
    assert.ok(res.droppedUnlistedKeys.includes('ARBITRARY_CUSTOM_ENV'));
    const mixed = buildSanitizedAgentEnv({ Path: 'system-path', agent_id: 'old' }, { AGENT_ID: 'new', unknown_secret: 'must-not-pass' });
    assert.strictEqual(mixed.env.PATH, 'system-path');
    assert.strictEqual(mixed.env.AGENT_ID, 'new');
    assert.strictEqual(mixed.env.agent_id, undefined);
    assert.strictEqual(mixed.env.unknown_secret, undefined);

    const mutableEnv: Record<string, string | undefined> = {
      AGENT_ID: 'dev-1',
      ADMIN_SECRET: 'secret-1',
      MASTER_SECRET: 'secret-2',
      CLIENT_TOKEN: 'dsu_client_123'
    };
    const stripped = stripSensitiveEnvInPlace(mutableEnv);
    assert.deepStrictEqual(stripped, ['ADMIN_SECRET', 'CLIENT_TOKEN', 'MASTER_SECRET']);
    assert.strictEqual(mutableEnv.AGENT_ID, 'dev-1');
    assert.strictEqual(mutableEnv.ADMIN_SECRET, undefined);
    passed++;
  } catch (err) {
    console.error('Sanitized env test failed:', err);
    failed++;
  }

  // 3. Log secret redaction
  try {
    const raw = 'token=dsu_device_abc123.sig ADMIN_SECRET=mysecret Bearer topsecret123';
    const redacted = redactSensitiveLogLine(raw);
    assert.ok(!redacted.includes('dsu_device_abc123'));
    assert.ok(!redacted.includes('mysecret'));
    assert.ok(!redacted.includes('topsecret123'));
    assert.ok(redacted.includes('<REDACTED'));
    passed++;
  } catch (err) {
    console.error('Log redaction test failed:', err);
    failed++;
  }

  // 4. Windows service scripts static contract verification (zero hardcoding / no Node count heuristic)
  try {
    const winDir = path.resolve(__dirname, '../../scripts/windows');
    const requiredFiles = [
      'agent-daemon.js',
      'ipc-control.js',
      'ipc-security.js',
      'ipc-private-acl.ps1',
      'launch-daemon.vbs',
      'service-config.json.example',
      'service-config.js',
      'service-common.ps1',
      'start-agent.ps1',
      'stop-agent.ps1',
      'restart-agent.ps1',
      'check-status.ps1',
      'register-agent-task.ps1',
      'unregister-agent-task.ps1',
      'Start-Agent.bat',
      'Stop-Agent.bat',
      'Restart-Agent.bat',
      'Status-Agent.bat',
      'Enable-AutoStart.bat',
      'Disable-AutoStart.bat'
    ];
    for (const file of requiredFiles) {
      const fullPath = path.join(winDir, file);
      assert.ok(fs.existsSync(fullPath), `Missing Windows service script: ${file}`);
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.ok(!content.includes('testuser'), `Hardcoded username found in ${file}`);
      assert.ok(!content.includes('devspace-ultra-src'), `Hardcoded legacy path found in ${file}`);
      assert.ok(!content.includes('nodeProcs.Count'), `Unsafe Node process count heuristic found in ${file}`);
    }

    const rootStartBat = fs.readFileSync(path.resolve(__dirname, '../../Start-Agent.bat'), 'utf8');
    const rootStopBat = fs.readFileSync(path.resolve(__dirname, '../../Stop-Agent.bat'), 'utf8');
    assert.ok(!rootStartBat.includes('testuser') && rootStartBat.includes('scripts\\windows\\start-agent.ps1'));
    assert.ok(!rootStopBat.includes('Stop-Process') && rootStopBat.includes('scripts\\windows\\stop-agent.ps1'));

    const registerPs1 = fs.readFileSync(path.join(winDir, 'register-agent-task.ps1'), 'utf8');
    assert.ok(registerPs1.includes('-RunLevel Limited'));
    assert.ok(registerPs1.includes('-MultipleInstances IgnoreNew'));
    assert.ok(registerPs1.includes('-ExecutionTimeLimit (New-TimeSpan -Days 0)'));

    const stopPs1 = fs.readFileSync(path.join(winDir, 'stop-agent.ps1'), 'utf8');
    assert.ok(stopPs1.includes('ipc-control.js'));
    assert.ok(!stopPs1.includes('Remove-Item') || !stopPs1.includes('.lock'));
    passed++;
  } catch (err) {
    console.error('Windows script static contract test failed:', err);
    failed++;
  }

  return { passed, failed };
}
