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
    ok(res.output.includes('global-gateway-singleton-recovery-20260910'), 'Output names singleton instance');
    ok(res.output.includes('SELECT taskId, status, backend'), 'Output contains correct SQL query');
    ok(res.output.includes('attemptsJson'), 'Output references attemptsJson');
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

  // Test 9: Legacy SQLite Row Format Simulation (Task A)
  try {
    // Legacy schema on main has taskId, status, backend, createdAt, leaseJson, attemptsJson
    // Notice: NO id, NO data, NO targetDeviceId column.
    const legacySqlRows = [
      {
        taskId: 'legacy-row-1',
        status: 'queued',
        backend: 'local',
        createdAt: 1700000000000,
        leaseJson: JSON.stringify({ claimedBy: 'win11-arm64-workstation', leaseExpiresAt: 1700001000000 }),
        attemptsJson: JSON.stringify([{ attemptId: 'att-1', claimedBy: 'win11-arm64-workstation', status: 'interrupted' }])
      },
      {
        taskId: 'legacy-row-2',
        status: 'queued',
        backend: 'local',
        createdAt: 1700000000100,
        leaseJson: null,
        attemptsJson: '[]'
      }
    ];

    // Simulate SQL extraction logic as run in Cloudflare Data Studio
    const extracted = legacySqlRows.map(r => ({
      taskId: r.taskId,
      status: r.status,
      backend: r.backend,
      leaseClaimant: r.leaseJson ? JSON.parse(r.leaseJson).claimedBy : null,
      leaseExpiresAt: r.leaseJson ? JSON.parse(r.leaseJson).leaseExpiresAt : null,
      firstAttemptClaimant: JSON.parse(r.attemptsJson)[0]?.claimedBy || null,
      hasTargetDeviceIdColumn: 'targetDeviceId' in r // false in legacy schema
    }));

    ok(extracted[0].taskId === 'legacy-row-1', 'Legacy row 1 taskId matches');
    ok(extracted[0].leaseClaimant === 'win11-arm64-workstation', 'Extracted leaseClaimant from leaseJson');
    ok(extracted[0].leaseExpiresAt === 1700001000000, 'Extracted leaseExpiresAt from leaseJson');
    ok(extracted[0].firstAttemptClaimant === 'win11-arm64-workstation', 'Extracted firstAttemptClaimant from attemptsJson');
    ok(extracted[0].hasTargetDeviceIdColumn === false, 'targetDeviceId column does NOT exist in legacy schema');

    ok(extracted[1].taskId === 'legacy-row-2', 'Legacy row 2 taskId matches');
    ok(extracted[1].leaseClaimant === null, 'Row 2 has null leaseClaimant (unassigned)');
    ok(extracted[1].firstAttemptClaimant === null, 'Row 2 has null firstAttemptClaimant (unassigned)');
  } catch (err: any) {
    console.error('Test 9 failed:', err);
  }

  // Test 10: Production readiness mode rejects non-local backend filter (Task B)
  try {
    const resBlocked = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      backend: 'kaggle', // partial filter
      checkReadiness: true
    });
    ok(resBlocked.exitCode === 2, 'Readiness mode rejects --backend kaggle with exitCode 2');
    ok(resBlocked.status === 'BLOCKED', 'Status is BLOCKED for non-local backend in readiness mode');
    ok(resBlocked.error?.includes('INVALID_PREFLIGHT_FILTER'), 'Error indicates invalid preflight filter');

    // With checkReadiness=false, partial query is allowed for diagnostic inspection
    const resAllowed = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      backend: 'kaggle',
      checkReadiness: false,
      fetchFn: async () => Response.json({
        ok: true,
        total: 1,
        offset: 0,
        limit: 1000,
        hasMore: false,
        summary: {
          totalActiveLocal: 0,
          totalTargeted: 0,
          totalQuarantined: 0,
          totalWithPriorClaimant: 0,
          byTargetDevice: {},
          byStatus: {}
        },
        tasks: [{ taskId: 'k-1', backend: 'kaggle', status: 'running' }]
      })
    });
    ok(resAllowed.exitCode === 0, 'Diagnostic mode allows --backend kaggle with exitCode 0');
  } catch (err: any) {
    console.error('Test 10 failed:', err);
  }

  // Test 11: Production readiness mode rejects partial status filter (Task B)
  try {
    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      status: 'queued', // partial filter
      checkReadiness: true
    });
    ok(res.exitCode === 2, 'Readiness mode rejects --status queued with exitCode 2');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED for non-active status in readiness mode');
    ok(res.error?.includes('INVALID_PREFLIGHT_FILTER'), 'Error indicates invalid preflight filter');
  } catch (err: any) {
    console.error('Test 11 failed:', err);
  }

  // Test 12: Production readiness mode rejects non-zero starting offset (Task B)
  try {
    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      offset: 10, // non-zero offset
      checkReadiness: true
    });
    ok(res.exitCode === 2, 'Readiness mode rejects --offset 10 with exitCode 2');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED for non-zero offset in readiness mode');
    ok(res.error?.includes('INVALID_PREFLIGHT_FILTER'), 'Error indicates invalid preflight filter');
  } catch (err: any) {
    console.error('Test 12 failed:', err);
  }

  // Test 13: Multi-page complete pagination (Task B)
  try {
    // Generate 25 tasks across 3 pages: 10 + 10 + 5
    const makeTask = (id: number) => ({
      taskId: `page-task-${id}`,
      backend: 'local',
      status: 'queued',
      targetDeviceId: 'win11-arm64-workstation',
      isQuarantined: false
    });

    const page1Tasks = Array.from({ length: 10 }, (_, i) => makeTask(i + 1));
    const page2Tasks = Array.from({ length: 10 }, (_, i) => makeTask(i + 11));
    const page3Tasks = Array.from({ length: 5 }, (_, i) => makeTask(i + 21));

    const commonSummary = {
      totalActiveLocal: 25,
      totalTargeted: 25,
      totalQuarantined: 0,
      totalWithPriorClaimant: 0,
      byTargetDevice: { 'win11-arm64-workstation': 25 },
      byStatus: { 'queued': 25 }
    };

    let fetchCount = 0;
    const multiPageFetch = async (url: string | URL | Request) => {
      fetchCount++;
      const urlStr = url.toString();
      if (urlStr.includes('offset=0')) {
        return Response.json({
          ok: true,
          total: 25,
          offset: 0,
          limit: 10,
          hasMore: true,
          summary: commonSummary,
          tasks: page1Tasks
        });
      } else if (urlStr.includes('offset=10')) {
        return Response.json({
          ok: true,
          total: 25,
          offset: 10,
          limit: 10,
          hasMore: true,
          summary: commonSummary,
          tasks: page2Tasks
        });
      } else if (urlStr.includes('offset=20')) {
        return Response.json({
          ok: true,
          total: 25,
          offset: 20,
          limit: 10,
          hasMore: false,
          summary: commonSummary,
          tasks: page3Tasks
        });
      }
      throw new Error(`Unexpected URL in test: ${urlStr}`);
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      limit: 10,
      offset: 0,
      checkReadiness: true,
      fetchFn: multiPageFetch
    });

    ok(fetchCount === 3, 'Fetched exactly 3 pages to complete inventory');
    ok(res.tasks?.length === 25, 'Accumulated all 25 tasks across pages');
    ok(res.exitCode === 0, 'Exit code is 0 (READY) after full pagination');
    ok(res.status === 'READY', 'Status is READY after full pagination');
  } catch (err: any) {
    console.error('Test 13 failed:', err);
  }

  // Test 14: Pagination shift - total count changes between pages (Task B)
  try {
    let callNum = 0;
    const shiftingFetch = async (url: string | URL | Request) => {
      callNum++;
      if (callNum === 1) {
        return Response.json({
          ok: true,
          total: 20,
          offset: 0,
          limit: 10,
          hasMore: true,
          summary: {
            totalActiveLocal: 20,
            totalTargeted: 20,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            byTargetDevice: { 'win11': 20 },
            byStatus: { 'queued': 20 }
          },
          tasks: Array.from({ length: 10 }, (_, i) => ({
            taskId: `shift-t-${i}`,
            backend: 'local',
            status: 'queued',
            targetDeviceId: 'win11',
            isQuarantined: false
          }))
        });
      } else {
        // Between page 1 and 2, a task was added, shifting total to 21
        return Response.json({
          ok: true,
          total: 21,
          offset: 10,
          limit: 10,
          hasMore: false,
          summary: {
            totalActiveLocal: 21,
            totalTargeted: 21,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            byTargetDevice: { 'win11': 21 },
            byStatus: { 'queued': 21 }
          },
          tasks: Array.from({ length: 11 }, (_, i) => ({
            taskId: `shift-t-${i + 10}`,
            backend: 'local',
            status: 'queued',
            targetDeviceId: 'win11',
            isQuarantined: false
          }))
        });
      }
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      limit: 10,
      offset: 0,
      checkReadiness: true,
      fetchFn: shiftingFetch
    });

    ok(res.exitCode === 2, 'Total shift between pages returns exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED when pagination total shifts');
    ok(res.error?.includes('PAGINATION_SHIFT_DETECTED'), 'Error indicates PAGINATION_SHIFT_DETECTED');
  } catch (err: any) {
    console.error('Test 14 failed:', err);
  }

  // Test 15: Pagination offset mismatch (Task B)
  try {
    let callNum = 0;
    const offsetMismatchFetch = async () => {
      callNum++;
      if (callNum === 1) {
        return Response.json({
          ok: true,
          total: 20,
          offset: 0,
          limit: 10,
          hasMore: true,
          summary: {
            totalActiveLocal: 20,
            totalTargeted: 20,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            byTargetDevice: { 'win11': 20 },
            byStatus: { 'queued': 20 }
          },
          tasks: Array.from({ length: 10 }, (_, i) => ({
            taskId: `offset-t-${i}`,
            backend: 'local',
            status: 'queued',
            targetDeviceId: 'win11',
            isQuarantined: false
          }))
        });
      } else {
        // Server returned offset 8 instead of offset 10
        return Response.json({
          ok: true,
          total: 20,
          offset: 8,
          limit: 10,
          hasMore: false,
          summary: {
            totalActiveLocal: 20,
            totalTargeted: 20,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            byTargetDevice: { 'win11': 20 },
            byStatus: { 'queued': 20 }
          },
          tasks: Array.from({ length: 10 }, (_, i) => ({
            taskId: `offset-t-${i + 10}`,
            backend: 'local',
            status: 'queued',
            targetDeviceId: 'win11',
            isQuarantined: false
          }))
        });
      }
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      limit: 10,
      offset: 0,
      checkReadiness: true,
      fetchFn: offsetMismatchFetch
    });

    ok(res.exitCode === 2, 'Offset mismatch returns exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED when offset mismatches');
    ok(res.error?.includes('PAGINATION_OFFSET_MISMATCH'), 'Error indicates PAGINATION_OFFSET_MISMATCH');
  } catch (err: any) {
    console.error('Test 15 failed:', err);
  }

  // Test 16: Pagination duplicate task ID across pages (Task B)
  try {
    let callNum = 0;
    const dupFetch = async () => {
      callNum++;
      if (callNum === 1) {
        return Response.json({
          ok: true,
          total: 20,
          offset: 0,
          limit: 10,
          hasMore: true,
          summary: {
            totalActiveLocal: 20,
            totalTargeted: 20,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            byTargetDevice: { 'win11': 20 },
            byStatus: { 'queued': 20 }
          },
          tasks: Array.from({ length: 10 }, (_, i) => ({
            taskId: `dup-t-${i}`,
            backend: 'local',
            status: 'queued',
            targetDeviceId: 'win11',
            isQuarantined: false
          }))
        });
      } else {
        // Page 2 also contains dup-t-0!
        return Response.json({
          ok: true,
          total: 20,
          offset: 10,
          limit: 10,
          hasMore: false,
          summary: {
            totalActiveLocal: 20,
            totalTargeted: 20,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            byTargetDevice: { 'win11': 20 },
            byStatus: { 'queued': 20 }
          },
          tasks: [
            { taskId: 'dup-t-0', backend: 'local', status: 'queued', targetDeviceId: 'win11', isQuarantined: false },
            ...Array.from({ length: 9 }, (_, i) => ({
              taskId: `dup-t-${i + 11}`,
              backend: 'local',
              status: 'queued',
              targetDeviceId: 'win11',
              isQuarantined: false
            }))
          ]
        });
      }
    };

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      limit: 10,
      offset: 0,
      checkReadiness: true,
      fetchFn: dupFetch
    });

    ok(res.exitCode === 2, 'Duplicate task ID returns exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED when duplicate task ID encountered');
    ok(res.error?.includes('PAGINATION_DUPLICATE_TASK'), 'Error indicates PAGINATION_DUPLICATE_TASK');
  } catch (err: any) {
    console.error('Test 16 failed:', err);
  }

  // Test 17: Pagination count mismatch - total accumulated does not match expected total (Task B)
  try {
    const mismatchCountFetch = async () => Response.json({
      ok: true,
      total: 10,
      offset: 0,
      limit: 10,
      hasMore: false, // says complete page, but only returns 8 tasks!
      summary: {
        totalActiveLocal: 10,
        totalTargeted: 10,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11': 10 },
        byStatus: { 'queued': 10 }
      },
      tasks: Array.from({ length: 8 }, (_, i) => ({
        taskId: `count-mismatch-${i}`,
        backend: 'local',
        status: 'queued',
        targetDeviceId: 'win11',
        isQuarantined: false
      }))
    });

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      limit: 10,
      offset: 0,
      checkReadiness: true,
      fetchFn: mismatchCountFetch
    });

    ok(res.exitCode === 2, 'Accumulated count mismatch returns exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED on count mismatch');
    ok(res.error?.includes('PAGINATION_INCONSISTENCY') || res.error?.includes('PAGINATION_COUNT_MISMATCH'), 'Error indicates count inconsistency');
  } catch (err: any) {
    console.error('Test 17 failed:', err);
  }

  // Test 18: Pagination inconsistency - hasMore=true with partial page (Task B)
  try {
    const partialHasMoreFetch = async () => Response.json({
      ok: true,
      total: 20,
      offset: 0,
      limit: 10,
      hasMore: true, // says hasMore, but returned only 5 tasks when limit is 10
      summary: {
        totalActiveLocal: 20,
        totalTargeted: 20,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        byTargetDevice: { 'win11': 20 },
        byStatus: { 'queued': 20 }
      },
      tasks: Array.from({ length: 5 }, (_, i) => ({
        taskId: `partial-hasmore-${i}`,
        backend: 'local',
        status: 'queued',
        targetDeviceId: 'win11',
        isQuarantined: false
      }))
    });

    const res = await runTaskInventory({
      gatewayUrl: 'http://localhost:4000',
      adminSecret: 'valid-secret',
      limit: 10,
      offset: 0,
      checkReadiness: true,
      fetchFn: partialHasMoreFetch
    });

    ok(res.exitCode === 2, 'hasMore=true with partial page returns exit code 2 (BLOCKED)');
    ok(res.status === 'BLOCKED', 'Status is BLOCKED on partial hasMore page');
    ok(res.error?.includes('PAGINATION_INCONSISTENCY'), 'Error indicates PAGINATION_INCONSISTENCY');
  } catch (err: any) {
    console.error('Test 18 failed:', err);
  }

  console.log(`Unit: Read-Only Task Inventory: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (require.main === module) {
  runInventoryTasksUnitTests().then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
