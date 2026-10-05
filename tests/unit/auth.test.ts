import * as assert from 'assert';
import * as fs from 'fs';
import { AuthManager } from '../../src/security/auth-manager';

export async function runAuthUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  const testDir = '.devspace-storage-test-auth';
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  try {
    const authManager = new AuthManager('test-master-secret', testDir);

    // Test 1: Register client and validate token
    {
      const { clientId, token } = authManager.registerClient('Test ChatGPT Client', ['kaggle:submit', 'local:read']);
      const val = authManager.validateToken(token);
      assert.strictEqual(val.valid, true, 'Client token should be valid');
      assert.strictEqual(val.payload?.subjectId, clientId, 'Subject ID should match');
      assert.deepStrictEqual(val.payload?.scopes, ['kaggle:submit', 'local:read'], 'Scopes should match');
      passed++;
    }

    // Test 2: Register device and validate device token
    {
      const { deviceId, token } = authManager.registerDevice('Windows Desktop 1', 'windows', ['local:read', 'local:write']);
      const val = authManager.validateToken(token);
      assert.strictEqual(val.valid, true, 'Device token should be valid');
      assert.strictEqual(val.payload?.type, 'device', 'Token type should be device');
      assert.strictEqual(val.payload?.subjectId, deviceId, 'Device ID should match');
      passed++;
    }

    // Test 3: Expired token
    {
      const { token } = authManager.generateToken('test-expired-user', 'client', ['admin'], -1000);
      const val = authManager.validateToken(token);
      assert.strictEqual(val.valid, false, 'Expired token must be invalid');
      assert.strictEqual(val.error, 'TOKEN_EXPIRED', 'Error code should be TOKEN_EXPIRED');
      passed++;
    }

    // Test 4: Forged signature token
    {
      const { token } = authManager.generateToken('test-forged-user', 'client', ['admin']);
      const forgedToken = token.slice(0, -5) + 'abcde';
      const val = authManager.validateToken(forgedToken);
      assert.strictEqual(val.valid, false, 'Forged token must be rejected');
      assert.strictEqual(val.error, 'INVALID_SIGNATURE', 'Error code should be INVALID_SIGNATURE');
      passed++;
    }

    // Test 5: Revoked token
    {
      const { token, payload } = authManager.generateToken('test-revoked-user', 'client', ['admin']);
      authManager.revokeToken(payload.tokenId);
      const val = authManager.validateToken(token);
      assert.strictEqual(val.valid, false, 'Revoked token must be invalid');
      assert.strictEqual(val.error, 'TOKEN_REVOKED', 'Error code should be TOKEN_REVOKED');
      passed++;
    }

    // Test 6: Revoked device
    {
      const { deviceId, token } = authManager.registerDevice('Windows Revoked', 'windows');
      authManager.revokeDevice(deviceId, 'Compromised device');
      const val = authManager.validateToken(token);
      assert.strictEqual(val.valid, false, 'Revoked device token must be rejected');
      assert.strictEqual(val.error, 'DEVICE_REVOKED', 'Error code should be DEVICE_REVOKED');
      passed++;
    }
  } catch (err: any) {
    console.error('Auth test failed:', err);
    failed++;
  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  return { passed, failed };
}
