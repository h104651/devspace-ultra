import * as assert from 'assert';
import { redactText, redactObject } from '../../src/security/redactor';

export async function runRedactorUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    // Test 1: Redact Bearer token in text
    const text1 = 'Authorization: Bearer dsu_client_eyJhYmM.sig12345';
    const clean1 = redactText(text1);
    assert.ok(!clean1.includes('dsu_client_eyJhYmM'), 'Bearer token should be redacted');
    assert.ok(clean1.includes('[REDACTED_TOKEN]') || clean1.includes('[REDACTED_SECRET]'));
    passed++;

    // Test 2: Redact Kaggle API key
    const text2 = 'KAGGLE_KEY="7984f479a8bc43d1a65f90d56b6a3782"';
    const clean2 = redactText(text2);
    assert.ok(!clean2.includes('7984f479a8bc43d1a65f90d56b6a3782'), 'Kaggle key must be redacted');
    passed++;

    // Test 3: Redact Nested Object
    const payload = {
      user: 'alice',
      credentials: {
        apiKey: 'secret-api-key-12345678',
        password: 'my-super-secret-password'
      },
      tokens: ['token: dsu_device_1234567890']
    };
    const cleanObj = redactObject(payload);
    assert.strictEqual(cleanObj.user, 'alice');
    assert.strictEqual(cleanObj.credentials.apiKey, '[REDACTED]');
    assert.strictEqual(cleanObj.credentials.password, '[REDACTED]');
    passed++;
  } catch (err: any) {
    console.error('Redactor test failed:', err);
    failed++;
  }

  return { passed, failed };
}
