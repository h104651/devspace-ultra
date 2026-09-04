import * as assert from 'assert';
import * as fs from 'fs';
import { AuthManager } from '../../src/security/auth-manager';
import { AuditLogger } from '../../src/security/audit-logger';

export async function runBootstrapTokenSecurityTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-bootstrap';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  try {
    const authManager = new AuthManager('test-master-secret', testDir);
    const auditLogger = new AuditLogger(testDir);

    // Test 1: Generate initial token
    const { token, payload } = authManager.generateToken('client-bootstrap', 'client', ['admin'], 3600000);
    assert.ok(token.startsWith('dsu_client_'));
    passed++;

    // Test 2: Ensure token is NOT present in audit logs when logged
    auditLogger.log({
      actor: 'client-bootstrap',
      actorType: 'client',
      action: 'BOOTSTRAP_INIT',
      result: 'SUCCESS',
      details: {
        tokenString: token,
        secretKey: 'super-secret-key-1234'
      }
    });

    const recentLogs = auditLogger.getRecentLogs(10);
    assert.strictEqual(recentLogs.length, 1);
    const logDetails = recentLogs[0].details as any;
    assert.strictEqual(logDetails.tokenString, '[REDACTED]');
    assert.strictEqual(logDetails.secretKey, '[REDACTED]');
    passed++;

    // Test 3: Token rotation (revoke old tokenId, issue new token)
    authManager.revokeToken(payload.tokenId);
    const oldVal = authManager.validateToken(token);
    assert.strictEqual(oldVal.valid, false, 'Old token must be invalid after rotation/revocation');
    assert.strictEqual(oldVal.error, 'TOKEN_REVOKED');

    const { token: newToken } = authManager.generateToken('client-bootstrap', 'client', ['admin']);
    const newVal = authManager.validateToken(newToken);
    assert.strictEqual(newVal.valid, true, 'New rotated token must be valid');
    passed++;
  } catch (err: any) {
    console.error('Bootstrap token security test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
