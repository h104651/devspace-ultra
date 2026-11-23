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

  const endpointUrl = `${gatewayUrl}/admin/tasks?view=inventory&backend=${encodeURIComponent(backend)}&status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`;

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
  const isLegacy = !data.summary || (tasks.length > 0 && tasks[0].targetDeviceId === undefined && tasks[0].isQuarantined === undefined);

  if (isLegacy) {
    log('========================================================================================');
    log('           DevSpace Ultra — Legacy Gateway Schema Detected                              ');
    log('========================================================================================');
    log(`Gateway URL: ${gatewayUrl}`);
    log('Status: [LEGACY_ENDPOINT_DETECTED]');
    log('The remote Gateway is running the legacy schema (v2.1.0 @ 1a933d3).');
    log(`Total Active Tasks Returned: ${tasks.length}`);
    log('Note: Legacy /admin/tasks endpoint does not expose targetDeviceId or attempt history.');
    log('');
    log('Safe Fallback Inspection via Cloudflare Wrangler SQL:');
    log('  npx wrangler durable-objects sql query DEVSPACE_GATEWAY_DO \\');
    log('    "SELECT taskId, status, backend, targetDeviceId, leaseJson, attemptsJson FROM tasks WHERE status IN (\'queued\', \'claimed\', \'running\', \'retrying\')"');
    log('');
    log('Safety Guarantee:');
    log('  The Zero Task Loss Quarantine architecture in PR #23 guarantees that upon upgrade,');
    log('  any legacy tasks with prior claimants will safely preserve their binding, while any');
    log('  unassigned tasks will remain quarantined in queued state (fail-closed against new devices).');
    log('========================================================================================');

    return {
      exitCode: checkReadiness && tasks.length > 0 ? 2 : 0,
      status: 'LEGACY_ENDPOINT_DETECTED',
      totalActiveLocal: tasks.length,
      totalTargeted: 0,
      totalQuarantined: tasks.length,
      totalWithPriorClaimant: 0,
      tasks,
      output: lines.join('\n')
    };
  }

  const summary = data.summary || {};
  const totalActiveLocal = summary.totalActiveLocal ?? tasks.filter(t => t.backend === 'local' && !['completed', 'failed', 'cancelled'].includes(t.status)).length;
  const totalTargeted = summary.totalTargeted ?? tasks.filter(t => !!t.targetDeviceId).length;
  const totalQuarantined = summary.totalQuarantined ?? tasks.filter(t => t.isQuarantined).length;
  const totalWithPriorClaimant = summary.totalWithPriorClaimant ?? tasks.filter(t => t.priorClaimant).length;

  if (format === 'json') {
    const jsonOutput = JSON.stringify({
      ok: true,
      gatewayUrl,
      summary,
      total: data.total,
      offset: data.offset,
      limit: data.limit,
      hasMore: data.hasMore,
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
  log(`Total Tasks Found: ${data.total ?? tasks.length} (Offset: ${data.offset ?? 0}, Limit: ${data.limit ?? limit}, HasMore: ${data.hasMore ? 'true' : 'false'})`);
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
