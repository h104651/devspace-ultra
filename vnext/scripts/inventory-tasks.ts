/**
 * DevSpace Ultra vNext — Read-Only Active Task Inventory & Preflight Readiness Checker
 *
 * This script queries the protected administrative endpoint on the Gateway to inspect
 * all active local tasks, verify their targetDeviceId bindings, claimant history,
 * and identify any orphaned or quarantined legacy tasks.
 *
 * Strict Guarantees:
 * 1. Read-Only: Never mutates task state, triggers claims, migrations, or recoveries.
 * 2. Redacted: Never displays confidential code, payload tokens, or secrets.
 * 3. Exit Codes:
 *    - 0: SUCCESS / READY (All active local tasks are properly targeted and verified)
 *    - 1: ERROR (Network failure, invalid secret, or parsing error)
 *    - 2: BLOCKED / MANUAL_REVIEW_REQUIRED (Quarantined tasks exist or credentials missing)
 */

export interface InventoryOptions {
  gatewayUrl?: string;
  adminSecret?: string;
  backend?: string;
  status?: string;
  limit?: number;
  offset?: number;
  format?: 'table' | 'json';
  checkReadiness?: boolean;
  fetchFn?: typeof fetch;
}

export interface InventoryResult {
  exitCode: number;
  status: 'READY' | 'BLOCKED' | 'ERROR' | 'LEGACY_ENDPOINT_DETECTED';
  totalActiveLocal: number;
  totalTargeted: number;
  totalQuarantined: number;
  totalWithPriorClaimant: number;
  summary?: any;
  tasks?: any[];
  error?: string;
  output: string;
}

export async function runTaskInventory(options: InventoryOptions): Promise<InventoryResult> {
  const gatewayUrl = (options.gatewayUrl || process.env.GATEWAY_URL || 'https://devspace-ultra-gateway.abdul-hsu.workers.dev').replace(/\/+$/, '');
  const adminSecret = options.adminSecret || process.env.ADMIN_SECRET;
  const backend = options.backend || 'local';
  const status = options.status || 'active';
  const limit = options.limit || 1000;
  const offset = options.offset || 0;
  const format = options.format || 'table';
  const checkReadiness = options.checkReadiness !== false;
  const customFetch = options.fetchFn || fetch;

  const lines: string[] = [];
  const log = (msg: string = '') => lines.push(msg);

  if (!adminSecret) {
    log('========================================================================================');
    log('           DevSpace Ultra vNext — Preflight Task Inventory (BLOCKED)                    ');
    log('========================================================================================');
    log(`Gateway URL: ${gatewayUrl}`);
    log('Status: [PREFLIGHT BLOCKED] Missing ADMIN_SECRET.');
    log('Reason: Administrative authorization is required to inspect protected tasks.');
    log('Action: Set ADMIN_SECRET in environment or pass via --admin-secret.');
    log('');
    log('Under Zero Trust protocol, production deployment is: NO-GO until verified.');
    log('========================================================================================');
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: 0,
      totalTargeted: 0,
      totalQuarantined: 0,
      totalWithPriorClaimant: 0,
      error: 'Missing ADMIN_SECRET',
      output: lines.join('\n')
    };
  }

  // Task B: Production Readiness Mode Filter Enforcement
  if (checkReadiness) {
    if (backend !== 'local') {
      log('========================================================================================');
      log('           DevSpace Ultra vNext — Preflight Task Inventory (BLOCKED)                    ');
      log('========================================================================================');
      log(`Gateway URL: ${gatewayUrl}`);
      log(`Status: [PREFLIGHT BLOCKED] Invalid backend filter for readiness check: '${backend}'.`);
      log('Reason: Production readiness verification strictly requires evaluating all active local tasks (backend=local).');
      log('Action: Omit --backend or specify --backend local.');
      log('========================================================================================');
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `INVALID_PREFLIGHT_FILTER: backend must be 'local' for readiness check, got '${backend}'`,
        output: lines.join('\n')
      };
    }

    if (status !== 'active') {
      log('========================================================================================');
      log('           DevSpace Ultra vNext — Preflight Task Inventory (BLOCKED)                    ');
      log('========================================================================================');
      log(`Gateway URL: ${gatewayUrl}`);
      log(`Status: [PREFLIGHT BLOCKED] Partial status filter for readiness check: '${status}'.`);
      log('Reason: Production readiness verification strictly requires evaluating all active statuses (status=active).');
      log('Action: Omit --status or specify --status active.');
      log('========================================================================================');
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `INVALID_PREFLIGHT_FILTER: status must be 'active' for readiness check, got '${status}'`,
        output: lines.join('\n')
      };
    }

    if (offset !== 0) {
      log('========================================================================================');
      log('           DevSpace Ultra vNext — Preflight Task Inventory (BLOCKED)                    ');
      log('========================================================================================');
      log(`Gateway URL: ${gatewayUrl}`);
      log(`Status: [PREFLIGHT BLOCKED] Non-zero starting offset for readiness check: ${offset}.`);
      log('Reason: Production readiness verification must start from offset 0 to guarantee complete inventory.');
      log('Action: Omit --offset or specify --offset 0.');
      log('========================================================================================');
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `INVALID_PREFLIGHT_FILTER: offset must be 0 for readiness check, got ${offset}`,
        output: lines.join('\n')
      };
    }
  }

  // Multi-page pagination loop
  let currentOffset = offset;
  const allTasks: any[] = [];
  const seenTaskIds = new Set<string>();
  let expectedTotal: number | undefined = undefined;
  let firstPageSummary: any = undefined;
  let pageIndex = 0;
  const MAX_PAGES = 1000;

  while (true) {
    pageIndex++;
    if (pageIndex > MAX_PAGES) {
      log(`[ERROR] Pagination safety limit exceeded (> ${MAX_PAGES} pages).`);
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: allTasks.length,
        totalTargeted: 0,
        totalQuarantined: allTasks.length,
        totalWithPriorClaimant: 0,
        error: 'PAGINATION_LIMIT_EXCEEDED: exceeded maximum page count',
        output: lines.join('\n')
      };
    }

    const endpointUrl = `${gatewayUrl}/admin/tasks?view=inventory&backend=${encodeURIComponent(backend)}&status=${encodeURIComponent(status)}&limit=${limit}&offset=${currentOffset}`;

    let response: Response;
    try {
      response = await customFetch(endpointUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Admin-Secret': adminSecret
        }
      });
    } catch (err: any) {
      log(`[ERROR] Network error contacting Gateway: ${err.message || String(err)}`);
      return {
        exitCode: 1,
        status: 'ERROR',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: err.message,
        output: lines.join('\n')
      };
    }

    if (response.status === 401 || response.status === 403) {
      log(`[ERROR] Authentication failed (HTTP ${response.status}): Invalid ADMIN_SECRET.`);
      return {
        exitCode: 1,
        status: 'ERROR',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `HTTP ${response.status} Authentication Failure`,
        output: lines.join('\n')
      };
    }

    if (!response.ok) {
      log(`[ERROR] Gateway responded with HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      return {
        exitCode: 1,
        status: 'ERROR',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `HTTP ${response.status}`,
        output: lines.join('\n')
      };
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      log(`[ERROR] Failed to parse Gateway response as JSON: ${err.message}`);
      return {
        exitCode: 1,
        status: 'ERROR',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: 'JSON parse error',
        output: lines.join('\n')
      };
    }

    const tasks: any[] = Array.isArray(data.tasks) ? data.tasks : [];
    const isLegacy = !data.summary || typeof data.summary !== 'object' || (tasks.length > 0 && tasks.some(t => t.backend === 'local' && t.targetDeviceId === undefined && t.isQuarantined === undefined));

    if (isLegacy) {
      log('========================================================================================');
      log('           DevSpace Ultra — Legacy Gateway Schema Detected                              ');
      log('========================================================================================');
      log(`Gateway URL: ${gatewayUrl}`);
      log('Status: [LEGACY_ENDPOINT_DETECTED]');
      log('The remote Gateway is running the legacy schema (v2.1.0 @ 1a933d3).');
      log(`Total Active Tasks Returned: ${tasks.length}`);
      log('Note: Legacy /admin/tasks endpoint does not expose targetDeviceId, attempt history, or full summary.');
      log('Warning: A legacy endpoint CANNOT provide verifiable evidence of zero unassigned tasks.');
      log('');
      log('Safe Fallback Inspection via Cloudflare Durable Objects Data Studio:');
      log('  1. Navigate to Cloudflare Dashboard -> Workers & Pages -> devspace-ultra-gateway -> Durable Objects');
      log('  2. Select Durable Object Namespace: GatewayDurableObject');
      log('  3. Locate Singleton Instance: global-gateway-singleton-recovery-20260910');
      log('     (Derived from worker.ts: env.GATEWAY_DO.idFromName(\'global-gateway-singleton-recovery-20260910\'))');
      log('  4. In Storage / Data Studio SQL Console, execute the read-only query on table \'tasks\':');
      log('       SELECT taskId, status, backend, createdAt,');
      log('              json_extract(leaseJson, \'$.claimedBy\') AS leaseClaimant,');
      log('              json_extract(leaseJson, \'$.leaseExpiresAt\') AS leaseExpiresAt,');
      log('              json_extract(attemptsJson, \'$[0].claimedBy\') AS firstAttemptClaimant,');
      log('              attemptsJson');
      log('       FROM tasks');
      log('       WHERE backend = \'local\'');
      log('         AND status IN (\'queued\', \'claimed\', \'acknowledged\', \'running\', \'retrying\')');
      log('       ORDER BY createdAt ASC;');
      log('  5. Legacy Schema Note: On main (v2.1.0), the \'targetDeviceId\' column does NOT exist yet.');
      log('     All active local tasks without prior claimants in leaseJson/attemptsJson are legacy unassigned tasks.');
      log('  6. Verification Status: PREFLIGHT BLOCKED (Production Cloudflare DO inspection not performed locally;');
      log('     operator must run this query in Cloudflare Data Studio before production deployment).');
      log('  7. Required Permissions: Workers Administrator or Account Administrator (Durable Objects Storage Read)');
      log('');
      log('Safety Guarantee:');
      log('  Under Zero Trust preflight rules, a legacy endpoint is STRICTLY BLOCKED from automated readiness.');
      log('  The Zero Task Loss Quarantine architecture in PR #23 guarantees that upon upgrade,');
      log('  any legacy tasks with prior claimants will safely preserve their binding, while any');
      log('  unassigned tasks will remain quarantined in queued state (fail-closed against new devices).');
      log('========================================================================================');

      return {
        exitCode: 2, // Always Exit Code 2 for Legacy Endpoint (cannot prove readiness)
        status: 'LEGACY_ENDPOINT_DETECTED',
        totalActiveLocal: tasks.length,
        totalTargeted: 0,
        totalQuarantined: tasks.length,
        totalWithPriorClaimant: 0,
        tasks,
        output: lines.join('\n')
      };
    }

    // Modern Endpoint Strict Schema Validation
    if (data.ok !== true) {
      log(`[ERROR] Response indicates failure: ${data.error || 'ok !== true'}`);
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `API error: ${data.error || 'ok !== true'}`,
        output: lines.join('\n')
      };
    }

    if (typeof data.total !== 'number' || typeof data.offset !== 'number' || typeof data.limit !== 'number' || typeof data.hasMore !== 'boolean') {
      log('[ERROR] Invalid response schema: missing pagination metadata (total, offset, limit, hasMore)');
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: 'SCHEMA_INVALID: missing pagination metadata',
        output: lines.join('\n')
      };
    }

    if (data.offset !== currentOffset) {
      log(`[ERROR] Pagination mismatch: expected offset ${currentOffset}, but Gateway returned offset ${data.offset}`);
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `PAGINATION_OFFSET_MISMATCH: expected ${currentOffset}, got ${data.offset}`,
        output: lines.join('\n')
      };
    }

    if (expectedTotal === undefined) {
      expectedTotal = data.total;
      firstPageSummary = data.summary;
    } else if (data.total !== expectedTotal) {
      log(`[ERROR] Pagination shift detected: total active tasks changed from ${expectedTotal} to ${data.total} during pagination`);
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `PAGINATION_SHIFT_DETECTED: total changed from ${expectedTotal} to ${data.total}`,
        output: lines.join('\n')
      };
    }

    if (tasks.length > data.limit) {
      log(`[ERROR] Pagination inconsistency: tasks length ${tasks.length} exceeds limit ${data.limit}`);
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: 'PAGINATION_INCONSISTENCY: task count exceeds limit',
        output: lines.join('\n')
      };
    }

    if (data.hasMore && tasks.length < data.limit) {
      log(`[ERROR] Pagination inconsistency: hasMore is true but page returned fewer tasks than limit (${tasks.length} < ${data.limit})`);
      return {
        exitCode: 2,
        status: 'BLOCKED',
        totalActiveLocal: 0,
        totalTargeted: 0,
        totalQuarantined: 0,
        totalWithPriorClaimant: 0,
        error: `PAGINATION_INCONSISTENCY: hasMore=true with partial page (${tasks.length} < ${data.limit})`,
        output: lines.join('\n')
      };
    }

    // Task schema checks for this page
    for (const t of tasks) {
      if (!t.taskId || typeof t.taskId !== 'string' || !t.status || typeof t.status !== 'string' || !t.backend) {
        log(`[ERROR] Task schema invalid: task missing taskId, status, or backend (${JSON.stringify(t)})`);
        return {
          exitCode: 2,
          status: 'BLOCKED',
          totalActiveLocal: 0,
          totalTargeted: 0,
          totalQuarantined: 0,
          totalWithPriorClaimant: 0,
          error: 'TASK_SCHEMA_INVALID: missing required task fields',
          output: lines.join('\n')
        };
      }
      if (t.backend === 'local') {
        if (typeof t.isQuarantined !== 'boolean') {
          log(`[ERROR] Task schema invalid: local task ${t.taskId} missing boolean isQuarantined flag`);
          return {
            exitCode: 2,
            status: 'BLOCKED',
            totalActiveLocal: 0,
            totalTargeted: 0,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            error: 'TASK_SCHEMA_INVALID: missing isQuarantined',
            output: lines.join('\n')
          };
        }
        if (t.isQuarantined && t.targetDeviceId) {
          log(`[ERROR] Task schema contradiction: task ${t.taskId} isQuarantined=true but has targetDeviceId '${t.targetDeviceId}'`);
          return {
            exitCode: 2,
            status: 'BLOCKED',
            totalActiveLocal: 0,
            totalTargeted: 0,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            error: 'TASK_SCHEMA_INVALID: quarantined task has targetDeviceId',
            output: lines.join('\n')
          };
        }
        if (!t.isQuarantined && (!t.targetDeviceId || typeof t.targetDeviceId !== 'string')) {
          log(`[ERROR] Task schema contradiction: task ${t.taskId} isQuarantined=false but missing targetDeviceId`);
          return {
            exitCode: 2,
            status: 'BLOCKED',
            totalActiveLocal: 0,
            totalTargeted: 0,
            totalQuarantined: 0,
            totalWithPriorClaimant: 0,
            error: 'TASK_SCHEMA_INVALID: non-quarantined task missing targetDeviceId',
            output: lines.join('\n')
          };
        }
      }

      if (seenTaskIds.has(t.taskId)) {
        log(`[ERROR] Pagination shift: duplicate task ${t.taskId} encountered across pages`);
        return {
          exitCode: 2,
          status: 'BLOCKED',
          totalActiveLocal: 0,
          totalTargeted: 0,
          totalQuarantined: 0,
          totalWithPriorClaimant: 0,
          error: `PAGINATION_DUPLICATE_TASK: task ${t.taskId} seen multiple times`,
          output: lines.join('\n')
        };
      }
      seenTaskIds.add(t.taskId);
      allTasks.push(t);
    }

    if (!data.hasMore) {
      break;
    }

    currentOffset += tasks.length;
  }

  const summary = firstPageSummary;
  if (!summary || typeof summary !== 'object' ||
      typeof summary.totalActiveLocal !== 'number' ||
      typeof summary.totalTargeted !== 'number' ||
      typeof summary.totalQuarantined !== 'number' ||
      typeof summary.totalWithPriorClaimant !== 'number' ||
      typeof summary.byTargetDevice !== 'object' || summary.byTargetDevice === null ||
      typeof summary.byStatus !== 'object' || summary.byStatus === null) {
    log('[ERROR] Invalid response schema: summary object missing or incomplete');
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: 0,
      totalTargeted: 0,
      totalQuarantined: 0,
      totalWithPriorClaimant: 0,
      error: 'SCHEMA_INVALID: incomplete summary metrics',
      output: lines.join('\n')
    };
  }

  // Statistical consistency checks
  if (summary.totalActiveLocal !== summary.totalTargeted + summary.totalQuarantined) {
    log(`[ERROR] Statistical contradiction: totalActiveLocal (${summary.totalActiveLocal}) !== totalTargeted (${summary.totalTargeted}) + totalQuarantined (${summary.totalQuarantined})`);
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: summary.totalActiveLocal,
      totalTargeted: summary.totalTargeted,
      totalQuarantined: summary.totalQuarantined,
      totalWithPriorClaimant: summary.totalWithPriorClaimant,
      error: 'STATISTICAL_CONTRADICTION: totalActiveLocal !== totalTargeted + totalQuarantined',
      output: lines.join('\n')
    };
  }

  if (summary.totalWithPriorClaimant > summary.totalQuarantined) {
    log(`[ERROR] Statistical contradiction: totalWithPriorClaimant (${summary.totalWithPriorClaimant}) exceeds totalQuarantined (${summary.totalQuarantined})`);
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: summary.totalActiveLocal,
      totalTargeted: summary.totalTargeted,
      totalQuarantined: summary.totalQuarantined,
      totalWithPriorClaimant: summary.totalWithPriorClaimant,
      error: 'STATISTICAL_CONTRADICTION: totalWithPriorClaimant > totalQuarantined',
      output: lines.join('\n')
    };
  }

  const byStatusSum = Object.values(summary.byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
  if (byStatusSum !== summary.totalActiveLocal) {
    log(`[ERROR] Statistical contradiction: sum of byStatus (${byStatusSum}) !== totalActiveLocal (${summary.totalActiveLocal})`);
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: summary.totalActiveLocal,
      totalTargeted: summary.totalTargeted,
      totalQuarantined: summary.totalQuarantined,
      totalWithPriorClaimant: summary.totalWithPriorClaimant,
      error: 'STATISTICAL_CONTRADICTION: sum of byStatus !== totalActiveLocal',
      output: lines.join('\n')
    };
  }

  // Verify all accumulated tasks against expectedTotal
  if (allTasks.length !== expectedTotal) {
    log(`[ERROR] Pagination inconsistency: accumulated tasks (${allTasks.length}) does not match expected total (${expectedTotal})`);
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: allTasks.length,
      totalTargeted: 0,
      totalQuarantined: allTasks.length,
      totalWithPriorClaimant: 0,
      error: `PAGINATION_INCONSISTENCY: accumulated tasks count mismatch (${allTasks.length} !== ${expectedTotal})`,
      output: lines.join('\n')
    };
  }

  // Check cumulative count matches summary if backend=local and status=active
  if (backend === 'local' && status === 'active' && allTasks.length !== summary.totalActiveLocal) {
    log(`[ERROR] Statistical contradiction: accumulated tasks length (${allTasks.length}) !== summary.totalActiveLocal (${summary.totalActiveLocal})`);
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal: summary.totalActiveLocal,
      totalTargeted: summary.totalTargeted,
      totalQuarantined: summary.totalQuarantined,
      totalWithPriorClaimant: summary.totalWithPriorClaimant,
      error: 'STATISTICAL_CONTRADICTION: accumulated tasks !== summary.totalActiveLocal',
      output: lines.join('\n')
    };
  }

  const tasks = allTasks;
  const ACTIVE_STATUS_SET = new Set(['queued', 'claimed', 'acknowledged', 'running', 'retrying']);
  const totalActiveLocal = summary.totalActiveLocal ?? tasks.filter(t => t.backend === 'local' && ACTIVE_STATUS_SET.has(t.status)).length;
  const totalTargeted = summary.totalTargeted ?? tasks.filter(t => !!t.targetDeviceId).length;
  const totalQuarantined = summary.totalQuarantined ?? tasks.filter(t => t.isQuarantined).length;
  const totalWithPriorClaimant = summary.totalWithPriorClaimant ?? tasks.filter(t => t.priorClaimant).length;

  if (format === 'json') {
    const jsonOutput = JSON.stringify({
      ok: true,
      gatewayUrl,
      summary,
      total: expectedTotal,
      offset,
      limit,
      hasMore: false,
      tasks
    }, null, 2);
    return {
      exitCode: totalQuarantined > 0 && checkReadiness ? 2 : 0,
      status: totalQuarantined > 0 ? 'BLOCKED' : 'READY',
      totalActiveLocal,
      totalTargeted,
      totalQuarantined,
      totalWithPriorClaimant,
      summary,
      tasks,
      output: jsonOutput
    };
  }

  log('========================================================================================');
  log('           DevSpace Ultra vNext — Active Local Task Inventory (Read-Only)               ');
  log('========================================================================================');
  log(`Gateway URL: ${gatewayUrl}`);
  log(`Total Tasks Found: ${expectedTotal ?? tasks.length} (Offset: ${offset}, Limit: ${limit}, Pages: ${pageIndex})`);
  log('');
  log(sprintf('%-18s %-12s %-26s %-20s %-12s', 'TASK ID', 'STATUS', 'TARGET DEVICE ID', 'PRIOR CLAIMANT', 'QUARANTINED'));
  log('-'.repeat(90));

  if (tasks.length === 0) {
    log('  (No active local tasks found)');
  } else {
    for (const t of tasks) {
      const target = t.targetDeviceId || '(unassigned)';
      const claimant = t.priorClaimant || 'none';
      const quarantined = t.isQuarantined ? 'YES' : 'NO';
      log(sprintf('%-18s %-12s %-26s %-20s %-12s',
        truncate(t.taskId, 18),
        truncate(t.status, 12),
        truncate(target, 26),
        truncate(claimant, 20),
        quarantined
      ));
    }
  }

  log('-'.repeat(90));
  log('Summary Statistics:');
  log(`  - Total Active Local Tasks:      ${totalActiveLocal}`);
  log(`  - Targeted & Bound Tasks:        ${totalTargeted}`);
  log(`  - Quarantined (Unassigned):      ${totalQuarantined}`);
  log(`  - Recoverable (Prior Claimant):  ${totalWithPriorClaimant}`);
  log('');

  if (summary.byTargetDevice && Object.keys(summary.byTargetDevice).length > 0) {
    log('Target Device Distribution:');
    for (const [devId, count] of Object.entries(summary.byTargetDevice)) {
      log(`  - ${devId}: ${count}`);
    }
    log('');
  }

  if (totalQuarantined > 0) {
    log('----------------------------------------------------------------------------------------');
    log(`[RESULT] PRODUCTION PREFLIGHT BLOCKED: ${totalQuarantined} task(s) are quarantined without targetDeviceId.`);
    log('Safety Rules:');
    log('  - Quarantined tasks are safely held in queued state and CANNOT be claimed by any agent.');
    log('  - Before production deployment, run administrative assignment to designate ownership:');
    log('      POST /admin/tasks/assign-legacy { "targetDeviceId": "win11-arm64-workstation" }');
    log('========================================================================================');
    return {
      exitCode: 2,
      status: 'BLOCKED',
      totalActiveLocal,
      totalTargeted,
      totalQuarantined,
      totalWithPriorClaimant,
      summary,
      tasks,
      output: lines.join('\n')
    };
  }

  log('----------------------------------------------------------------------------------------');
  log('[RESULT] PRODUCTION PREFLIGHT READY: All active tasks have verified target device bindings.');
  log('Zero orphaned tasks detected. Safe for deployment.');
  log('========================================================================================');

  return {
    exitCode: 0,
    status: 'READY',
    totalActiveLocal,
    totalTargeted,
    totalQuarantined,
    totalWithPriorClaimant,
    summary,
    tasks,
    output: lines.join('\n')
  };
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.substring(0, len - 3) + '...';
}

function sprintf(format: string, ...args: any[]): string {
  let i = 0;
  return format.replace(/%(-)?(\d+)?s/g, (_match, left, width) => {
    const val = String(args[i++] ?? '');
    const w = width ? parseInt(width, 10) : 0;
    if (val.length >= w) return val;
    const pad = ' '.repeat(w - val.length);
    return left ? val + pad : pad + val;
  });
}

// Direct CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const opts: InventoryOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gateway-url' && args[i + 1]) opts.gatewayUrl = args[++i];
    else if (args[i] === '--admin-secret' && args[i + 1]) opts.adminSecret = args[++i];
    else if (args[i] === '--backend' && args[i + 1]) opts.backend = args[++i];
    else if (args[i] === '--status' && args[i + 1]) opts.status = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    else if (args[i] === '--offset' && args[i + 1]) opts.offset = parseInt(args[++i], 10);
    else if (args[i] === '--format' && args[i + 1]) opts.format = args[++i] as any;
    else if (args[i] === '--check-readiness') opts.checkReadiness = true;
    else if (args[i] === '--no-check-readiness') opts.checkReadiness = false;
    else if (args[i] === '--help') {
      console.log(`
Usage: ts-node scripts/inventory-tasks.ts [options]

Options:
  --gateway-url <url>      Gateway URL (default: GATEWAY_URL or production)
  --admin-secret <secret>  X-Admin-Secret header value (default: ADMIN_SECRET)
  --backend <backend>      Task backend filter (default: local)
  --status <status>        Task status filter: active, queued, all (default: active)
  --limit <number>         Maximum tasks to inspect (default: 1000)
  --offset <number>        Pagination offset (default: 0)
  --format <table|json>    Output format (default: table)
  --check-readiness        Exit with code 2 if quarantined tasks found (default: true)
  --no-check-readiness     Disable readiness gate to inspect partial or filtered lists
  --help                   Show this help message
`);
      process.exit(0);
    }
  }

  runTaskInventory(opts).then(res => {
    console.log(res.output);
    process.exit(res.exitCode);
  }).catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
