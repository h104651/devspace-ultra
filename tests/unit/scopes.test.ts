import * as assert from 'assert';
import { ScopeChecker } from '../../src/security/scope-checker';

export async function runScopesUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    // Test 1: Admin has all scopes
    assert.strictEqual(ScopeChecker.hasScope(['admin'], 'kaggle:submit'), true);
    assert.strictEqual(ScopeChecker.hasScope(['admin'], 'local:write'), true);
    assert.strictEqual(ScopeChecker.hasScope(['admin'], 'raw_shell:run'), true);
    passed++;

    // Test 2: Specific scope match
    assert.strictEqual(ScopeChecker.hasScope(['kaggle:submit'], 'kaggle:submit'), true);
    assert.strictEqual(ScopeChecker.hasScope(['kaggle:submit'], 'kaggle:read'), true, 'kaggle:submit implies kaggle:read');
    assert.strictEqual(ScopeChecker.hasScope(['kaggle:submit'], 'local:read'), false, 'kaggle:submit must not grant local:read');
    passed++;

    // Test 3: Local write implies local read
    assert.strictEqual(ScopeChecker.hasScope(['local:write'], 'local:read'), true);
    assert.strictEqual(ScopeChecker.hasScope(['local:read'], 'local:write'), false);
    passed++;

    // Test 4: Capability to scope mappings
    assert.strictEqual(ScopeChecker.getRequiredScopeForCapability('kaggle:run'), 'kaggle:submit');
    assert.strictEqual(ScopeChecker.getRequiredScopeForCapability('kaggle:status'), 'kaggle:read');
    assert.strictEqual(ScopeChecker.getRequiredScopeForCapability('local:read_file'), 'local:read');
    assert.strictEqual(ScopeChecker.getRequiredScopeForCapability('local:write_file'), 'local:write');
    assert.strictEqual(ScopeChecker.getRequiredScopeForCapability('local:raw_shell'), 'raw_shell:run');
    passed++;
  } catch (err: any) {
    console.error('Scopes test failed:', err);
    failed++;
  }

  return { passed, failed };
}
