// Pure canonical argument construction, shared by local planning and execution.
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function onlyKeys(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected Git selection field');
}

// Git query inputs are operator-selected immutable object IDs, not arbitrary
// revision expressions, options, pathspecs, remotes or shell fragments.
export function buildGitReadArgs(id: 'git_log' | 'git_diff_commits', selection: unknown): string[] {
  if (!object(selection)) throw new Error('Explicit Git commit selection required');
  onlyKeys(selection, id === 'git_log' ? ['head', 'limit'] : ['base', 'head']);
  const oid = (value: unknown): string => {
    if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || /^0+$/.test(value)) {
      throw new Error('Full lowercase Git object ID required');
    }
    return value;
  };
  const head = oid(selection.head);
  // Explicit .git path prevents discovery in parent directories. No working
  // tree content, external diff/textconv, notes, signatures or replace refs.
  // Network is denied by AppContainer, not solely these Git options.
  const common = ['--no-pager', '--no-replace-objects', '--literal-pathspecs',
    '--git-dir=.git', '--work-tree=.', '-c', 'protocol.allow=never',
    '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];
  if (id === 'git_log') {
    const limit = selection.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Git log limit must be 1-100');
    return [...common, 'log', '--no-notes', '--no-show-signature', '--no-decorate',
      '--no-color', '--no-patch', '--format=%H%x09%P%x09%ct%x09%s', '--max-count=' + limit, head, '--'];
  }
  if (id !== 'git_diff_commits') throw new Error('Unknown Git read operation');
  const base = oid(selection.base);
  if (base.length !== head.length) throw new Error('Git object ID lengths must match');
  return [...common, 'diff-tree', '-r', '--no-commit-id', '--patch', '--no-ext-diff',
    '--no-textconv', '--no-renames', '--no-color', '--ignore-submodules=all', base, head, '--'];
}

/**
 * Reconstruct the entire canonical vector from its narrowly typed selection.
 * A locally edited profile must not turn a reserved read ID into another verb.
 */
export function validateGitReadProfile(id: 'git_log' | 'git_diff_commits', args: unknown): void {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('LOCAL_GIT_PROFILE_DENIED: Invalid Git read arguments.');
  }
  try {
    const head = args[args.length - 2];
    const selection = id === 'git_log'
      ? { head, limit: Number(/^--max-count=([0-9]+)$/.exec(args[args.length - 3])?.[1]) }
      : { base: args[args.length - 3], head };
    const canonical = buildGitReadArgs(id, selection);
    if (args.length !== canonical.length || canonical.some((arg, index) => arg !== args[index])) {
      throw new Error('Argument vector differs from canonical Git read plan');
    }
  } catch {
    throw new Error('LOCAL_GIT_PROFILE_DENIED: Reserved Git read profile requires canonical arguments.');
  }
}

// Both generic and dedicated MCP submission use this exact payload validator.
export function parseGitReadTask(payload: unknown): { projectId: string; operation: 'git_log' | 'git_diff_commits'; args: string[] } {
  if (!object(payload) || typeof payload.projectId !== 'string' || !/^[a-z0-9_.-]{1,128}$/.test(payload.projectId) ||
      (payload.operation !== 'git_log' && payload.operation !== 'git_diff_commits')) {
    throw new Error('INVALID_ARGUMENT: Explicit normalized projectId and supported Git operation required.');
  }
  const operation = payload.operation;
  const allowed = operation === 'git_log' ? ['projectId', 'operation', 'head', 'limit'] : ['projectId', 'operation', 'base', 'head'];
  if (Object.keys(payload).some(key => !allowed.includes(key))) {
    throw new Error('INVALID_ARGUMENT: Unexpected Git read task field.');
  }
  try {
    const selection = operation === 'git_log' ? { head: payload.head, limit: payload.limit } : { base: payload.base, head: payload.head };
    return { projectId: payload.projectId, operation, args: buildGitReadArgs(operation, selection) };
  } catch {
    throw new Error('INVALID_ARGUMENT: Git read requires full object IDs and a bounded log count.');
  }
}
