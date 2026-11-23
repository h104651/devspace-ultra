import * as assert from 'node:assert';
import { runTaskInventory, InventoryOptions } from '../../scripts/inventory-tasks';

export async function runInventoryTasksUnitTests(): Promise<{ passed: number; failed: number }> {
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

  console.log('\n--- Running Unit: Read-Only Task Inventory & Preflight Verification Tests ---');

  // Test 1: Missing ADMIN_SECRET returns exitCode 2 (BLOCKED)
  try {
    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: '' // missing
    });
    ok(res.exitCode === 2, 'Missing ADMIN_SECRET returns exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED');
    ok(res.output.includes('[PREFLIGHT BLOCKED] Missing ADMIN_SECRET'), 'Output mentions PREFLIGHT BLOCKED');
    ok(res.output.includes('NO-GO until verified'), 'Output contains NO-GO statement');
  } catch (err: any) {
    console.error('Test 1 failed:', err);
  }

  // Test 2: Network error returns exitCode 1 (ERROR)
  try {
    const res = await runTaskInventory({
      gatewayUrl: 'http://127.0.0.1:59999', // non-existent port
      adminSecret: 'test-secret',
      fetchFn: async () => { throw new Error('ECONNREFUSED'); }
    });
    ok(res.exitCode === 1, 'Network error returns exit code 1');
    ok(res.status === 'ERROR', 'Status is ERROR on network failure');
    ok(res.output.includes('Network error contacting Gateway'), 'Output logs network error');
  } catch (err: any) {
    console.error('Test 2 failed:', err);
  }

  // Test 3: HTTP 401 Unauthorized returns exitCode 1 (ERROR)
  try {
    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'wrong-secret',
      fetchFn: async () => new Response('Unauthorized', { status: 401 })
    });
    ok(res.exitCode === 1, 'HTTP 401 returns exit code 1');
    ok(res.output.includes('Authentication failed (HTTP 401)'), 'Output logs authentication failure');
  } catch (err: any) {
    console.error('Test 3 failed:', err);
  }

  // Test 4: Legacy Endpoint detection (v2.1.0 @ 1a933d3)
  try {
    const legacyResponse = {
      total: 2,
      tasks: [
        { taskId: 'legacy-t1', backend: 'local', capability: 'local:read', status: 'queued', createdAt: 1700000000000 },
        { taskId: 'legacy-t2', backend: 'local', capability: 'local:read', status: 'running', createdAt: 1700000000100 }
      ]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(legacyResponse)
    });

    ok(res.status === 'LEGACY_ENDPOINT_DETECTED', 'Detects legacy schema');
    ok(res.exitCode === 2, 'Returns exit code 2 when legacy tasks found and readiness checked');
    ok(res.output.includes('[LEGACY_ENDPOINT_DETECTED]'), 'Output indicates legacy endpoint');
    ok(res.output.includes('Cloudflare Durable Objects Data Studio'), 'Output provides Data Studio fallback instructions');
    ok(res.output.includes('GatewayDurableObject'), 'Output names correct Durable Object');
    ok(res.output.includes('devspace-gateway-default'), 'Output names singleton instance');
    ok(res.output.includes('SELECT id, status, backend'), 'Output contains correct SQL query');
    ok(res.output.includes('Zero Task Loss Quarantine'), 'Output explains Zero Task Loss Quarantine protection');
  } catch (err: any) {
    console.error('Test 4 failed:', err);
  }

  // Test 4b: Legacy Endpoint with 0 tasks MUST STILL RETURN exitCode 2 (Never false READY)
  try {
    const legacyEmptyResponse = {
      total: 0,
      tasks: []
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(legacyEmptyResponse)
    });

    ok(res.status === 'LEGACY_ENDPOINT_DETECTED', 'Detects legacy schema even on empty tasks');
    ok(res.exitCode === 2, 'Legacy endpoint with 0 tasks MUST return exit code 2 (Never false READY)');
    ok(res.output.includes('STRICTLY BLOCKED from automated readiness'), 'Output explains Zero Trust blocked legacy endpoint');
  } catch (err: any) {
    console.error('Test 4b failed:', err);
  }

  // Test 4c: Legacy Endpoint with > 100 tasks MUST RETURN exitCode 2
  try {
    const legacyLargeTasks = Array.from({ length: 150 }, (_, i) => ({
      taskId: `legacy-task-${i}`,
      backend: 'local',
      capability: 'local:read',
      status: 'queued'
    }));

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json({ total: 150, tasks: legacyLargeTasks })
    });

    ok(res.status === 'LEGACY_ENDPOINT_DETECTED', 'Detects legacy schema on large task set');
    ok(res.exitCode === 2, 'Legacy endpoint with 150 tasks returns exit code 2');
    ok(res.totalActiveLocal === 150, 'Reports 150 total active tasks');
  } catch (err: any) {
    console.error('Test 4c failed:', err);
  }

  // Test 4d: Modern Endpoint with Incomplete Summary (Schema Fail Closed -> exitCode 2)
  try {
    const incompleteSummaryResponse = {
      ok: true,
      total: 1,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 1,
        totalTargeted: 1
        // missing totalQuarantined, byTargetDevice, byStatus
      },
      tasks: [{ taskId: 't-1', backend: 'local', status: 'queued', targetDeviceId: 'win11', isQuarantined: false }]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(incompleteSummaryResponse)
    });

    ok(res.exitCode === 2, 'Incomplete summary fails closed with exit code 2');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED on incomplete summary');
    ok(res.error?.includes('SCHEMA_INVALID'), 'Error indicates schema invalidation');
  } catch (err: any) {
    console.error('Test 4d failed:', err);
  }

  // Test 4e: Modern Endpoint with Statistical Contradiction (totalActiveLocal != targeted + quarantined)
  try {
    const contradictionResponse = {
      ok: true,
      total: 2,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 5, // Contradiction! 2 + 1 != 5
        totalTargeted: 2,
        totalQuarantined: 1,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11': 2 },
        byStatus: { 'queued': 5 }
      },
      tasks: []
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(contradictionResponse)
    });

    ok(res.exitCode === 2, 'Statistical contradiction fails closed with exit code 2');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED on statistical contradiction');
    ok(res.error?.includes('STATISTICAL_CONTRADICTION'), 'Error reports statistical contradiction');
  } catch (err: any) {
    console.error('Test 4e failed:', err);
  }

  // Test 4f: Modern Endpoint with Statistical Contradiction (totalWithPriorClaimant > totalQuarantined)
  try {
    const contradictionPriorResponse = {
      ok: true,
      total: 2,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 2,
        totalTargeted: 1,
        totalQuarantined: 1,
        totalWithPriorClaimant: 3, // Contradiction! 3 > 1
        byTargetDevice: { 'win11': 1 },
        byStatus: { 'queued': 2 }
      },
      tasks: []
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(contradictionPriorResponse)
    });

    ok(res.exitCode === 2, 'Prior claimant contradiction fails closed with exit code 2');
    ok(res.error?.includes('STATISTICAL_CONTRADICTION'), 'Error reports prior claimant contradiction');
  } catch (err: any) {
    console.error('Test 4f failed:', err);
  }

  // Test 4g: Modern Endpoint with Statistical Contradiction (byStatus sum != totalActiveLocal)
  try {
    const contradictionStatusResponse = {
      ok: true,
      total: 2,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 2,
        totalTargeted: 2,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11': 2 },
        byStatus: { 'queued': 1 } // Sum is 1, but totalActiveLocal is 2!
      },
      tasks: []
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(contradictionStatusResponse)
    });

    ok(res.exitCode === 2, 'byStatus sum contradiction fails closed with exit code 2');
    ok(res.error?.includes('STATISTICAL_CONTRADICTION'), 'Error reports byStatus contradiction');
  } catch (err: any) {
    console.error('Test 4g failed:', err);
  }

  // Test 4h: Modern Endpoint with Pagination Inconsistency (complete page count mismatch)
  try {
    const paginationInconsistentResponse = {
      ok: true,
      total: 5,
      offset: 0,
      limit: 1000,
      hasMore: false, // Indicates full page!
      summary: {
        totalActiveLocal: 5,
        totalTargeted: 5,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11': 5 },
        byStatus: { 'queued': 5 }
      },
      tasks: [{ taskId: 't-1', backend: 'local', status: 'queued', targetDeviceId: 'win11', isQuarantined: false }] // Only 1 task returned!
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(paginationInconsistentResponse)
    });

    ok(res.exitCode === 2, 'Pagination inconsistency fails closed with exit code 2');
    ok(res.error?.includes('PAGINATION_INCONSISTENCY'), 'Error reports pagination inconsistency');
  } catch (err: any) {
    console.error('Test 4h failed:', err);
  }

  // Test 4i: Modern Endpoint with Invalid Task Schema (isQuarantined=true but has targetDeviceId)
  try {
    const invalidTaskSchemaResponse = {
      ok: true,
      total: 1,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 1,
        totalTargeted: 0,
        totalQuarantined: 1,
        totalWithPriorClaimant: 0,
        byTargetDevice: {},
        byStatus: { 'queued': 1 }
      },
      tasks: [
        {
          taskId: 't-invalid-schema',
          backend: 'local',
          status: 'queued',
          targetDeviceId: 'win11', // Contradiction with isQuarantined=true!
          isQuarantined: true
        }
      ]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      checkReadiness: true,
      fetchFn: async () => Response.json(invalidTaskSchemaResponse)
    });

    ok(res.exitCode === 2, 'Invalid task schema fails closed with exit code 2');
    ok(res.error?.includes('TASK_SCHEMA_INVALID'), 'Error reports task schema invalidity');
  } catch (err: any) {
    console.error('Test 4i failed:', err);
  }

  // Test 5: Modern Inventory with all tasks properly targeted (READY)
  try {
    const modernReadyResponse = {
      ok: true,
      total: 2,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 2,
        totalTargeted: 2,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11-arm64-workstation': 2 },
        byStatus: { 'queued': 1, 'running': 1 }
      },
      tasks: [
        {
          taskId: 'task-001',
          backend: 'local',
          capability: 'local:read',
          status: 'queued',
          targetDeviceId: 'win11-arm64-workstation',
          priorClaimant: 'win11-arm64-workstation',
          isQuarantined: false,
          attemptCount: 1,
          createdAt: 1700000000000
        },
        {
          taskId: 'task-002',
          backend: 'local',
          capability: 'local:exec',
          status: 'running',
          targetDeviceId: 'win11-arm64-workstation',
          priorClaimant: 'win11-arm64-workstation',
          isQuarantined: false,
          attemptCount: 1,
          createdAt: 1700000000100
        }
      ]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      fetchFn: async () => Response.json(modernReadyResponse)
    });

    ok(res.exitCode === 0, 'Modern ready inventory returns exit code 0');
    ok(res.status === 'READY', 'Status is READY');
    ok(res.totalActiveLocal === 2, 'Total active local is 2');
    ok(res.totalTargeted === 2, 'Total targeted is 2');
    ok(res.totalQuarantined === 0, 'Total quarantined is 0');
    ok(res.output.includes('[RESULT] PRODUCTION PREFLIGHT READY'), 'Output declares READY');
  } catch (err: any) {
    console.error('Test 5 failed:', err);
  }

  // Test 6: Modern Inventory with Quarantined tasks (BLOCKED)
  try {
    const modernBlockedResponse = {
      ok: true,
      total: 2,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 2,
        totalTargeted: 1,
        totalQuarantined: 1,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11-arm64-workstation': 1 },
        byStatus: { 'queued': 2 }
      },
      tasks: [
        {
          taskId: 'task-targeted',
          backend: 'local',
          capability: 'local:read',
          status: 'queued',
          targetDeviceId: 'win11-arm64-workstation',
          isQuarantined: false,
          createdAt: 1700000000000
        },
        {
          taskId: 'task-quarantined',
          backend: 'local',
          capability: 'local:read',
          status: 'queued',
          targetDeviceId: undefined,
          isQuarantined: true,
          createdAt: 1700000000100
        }
      ]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      fetchFn: async () => Response.json(modernBlockedResponse)
    });

    ok(res.exitCode === 2, 'Quarantined tasks return exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED');
    ok(res.totalQuarantined === 1, 'Total quarantined is 1');
    ok(res.output.includes('[RESULT] PRODUCTION PREFLIGHT BLOCKED'), 'Output declares PREFLIGHT BLOCKED');
    ok(res.output.includes('POST /admin/tasks/assign-legacy'), 'Output instructs operator how to assign');
  } catch (err: any) {
    console.error('Test 6 failed:', err);
  }

  // Test 7: Output redaction guarantee (no secrets or sensitive payload leaked)
  try {
    const sensitiveResponse = {
      ok: true,
      total: 1,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 1,
        totalTargeted: 1,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11-arm64-workstation': 1 },
        byStatus: { 'queued': 1 }
      },
      tasks: [
        {
          taskId: 'task-secret-test',
          backend: 'local',
          capability: 'local:read',
          status: 'queued',
          targetDeviceId: 'win11-arm64-workstation',
          isQuarantined: false,
          createdAt: 1700000000000
        }
      ]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'SUPER_TOP_SECRET_ADMIN_TOKEN',
      fetchFn: async () => Response.json(sensitiveResponse)
    });

    ok(!res.output.includes('SUPER_TOP_SECRET_ADMIN_TOKEN'), 'Admin secret is strictly redacted from output');
    ok(res.exitCode === 0, 'Clean run passed');
  } catch (err: any) {
    console.error('Test 7 failed:', err);
  }

  // Test 8: JSON Format Output
  try {
    const jsonTestResponse = {
      ok: true,
      total: 1,
      offset: 0,
      limit: 1000,
      hasMore: false,
      summary: {
        totalActiveLocal: 1,
        totalTargeted: 1,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11': 1 },
        byStatus: { 'queued': 1 }
      },
      tasks: [{ taskId: 'json-t1', backend: 'local', status: 'queued', targetDeviceId: 'win11', isQuarantined: false }]
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      format: 'json',
      fetchFn: async () => Response.json(jsonTestResponse)
    });

    const parsed = JSON.parse(res.output);
    ok(parsed.ok === true, 'JSON output contains ok: true');
    ok(parsed.summary.totalActiveLocal === 1, 'JSON output parsed correctly');
    ok(res.exitCode === 0, 'JSON run passed with exit code 0');
  } catch (err: any) {
    console.error('Test 8 failed:', err);
  }

  console.log(`Unit: Read-Only Task Inventory: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (require.main === module) {
  runInventoryTasksUnitTests().then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
