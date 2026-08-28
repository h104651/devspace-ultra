import * as assert from 'assert';
import { EnvironmentProbe } from '../../src/local-agent/environment-probe';

export async function runEnvironmentProbeUnitTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  try {
    // 1. Verify default capabilities reported by EnvironmentProbe.probe()
    const report = EnvironmentProbe.probe();
    assert.ok(report.capabilities, 'Report should have capabilities array');

    const expectedBaseCapabilities = [
      'local:list_projects',
      'local:project_status',
      'local:git_status',
      'local:read_file',
      'local:write_file',
      'local:patch_file',
      'local:run_tests'
    ];

    const expectedDiscoveryCapabilities = [
      'local:list_directory',
      'local:find_files',
      'local:search_text',
      'local:find_repositories',
      'local:create_directory'
    ];

    for (const cap of expectedBaseCapabilities) {
      assert.ok(
        report.capabilities.includes(cap),
        `Default probe report must include base capability '${cap}'`
      );
    }

    for (const cap of expectedDiscoveryCapabilities) {
      assert.ok(
        report.capabilities.includes(cap),
        `Default probe report must include PR #3 workspace discovery capability '${cap}'`
      );
    }
    passed++;

    // 2. Verify raw_shell option behavior
    const defaultWithoutShell = EnvironmentProbe.probe({ allowRawShell: false });
    assert.strictEqual(
      defaultWithoutShell.capabilities.includes('local:raw_shell'),
      false,
      'local:raw_shell must not be enabled when allowRawShell=false'
    );

    const withShell = EnvironmentProbe.probe({ allowRawShell: true });
    assert.strictEqual(
      withShell.capabilities.includes('local:raw_shell'),
      true,
      'local:raw_shell must be included when allowRawShell=true'
    );
    passed++;

  } catch (err: any) {
    console.error('EnvironmentProbe test failed:', err);
    failed++;
  }

  return { passed, failed };
}
