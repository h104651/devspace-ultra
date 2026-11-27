import { checkGitBranchPreflight, parseGitBranchIntent, GitBranchIntent, GitBranchSnapshot } from './plan-git-branch-mutations';

// Internal adapter contract, NOT an MCP request schema. A production adapter
// must establish the exclusive staged workspace, verified Git executable,
// zero-network process containment, protected local policy and durable fence.
// This candidate is not wired to the agent and does not establish those proofs.
export interface GitBranchLease {
  readonly approvedTargets: readonly string[];
  // An absolute, preverified empty directory owned by the execution policy.
  readonly emptyHooksDirectory: string;
  snapshot(intent: GitBranchIntent): Promise<GitBranchSnapshot>;
  // Optional until a protected staged index adapter is provisioned.
  readonly indexWorkspace?: { root: string; approvedPaths: readonly string[] };
  query?(args: readonly string[]): Promise<string>;
  // Resolve only after the entire process tree exits successfully.
  // Reject for any uncertainty, truncation, cancellation or nonzero exit.
  run(args: readonly string[]): Promise<void>;
  // Quarantine must retain the durable fence until operator reconciliation.
  finish(disposition: 'release' | 'quarantine'): Promise<void>;
}
export interface GitBranchAdapter {
  acquire(projectId: string): Promise<GitBranchLease>;
}

export function gitBranchMutationArgs(intent: GitBranchIntent, emptyHooksDirectory: string): string[] {
  // The directory comes only from the trusted adapter, never the task payload.
  if (typeof emptyHooksDirectory !== 'string' || !emptyHooksDirectory || /[\r\n\u0000]/.test(emptyHooksDirectory)) {
    throw new Error('GIT_HOOKS_POLICY_DENIED');
  }
  const checked = parseGitBranchIntent(intent);
  const common = ['--no-pager', '--no-replace-objects', '--literal-pathspecs',
    '--git-dir=.git', '--work-tree=.', '-c', 'protocol.allow=never',
    '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    '-c', 'core.hooksPath=' + emptyHooksDirectory, '-c', 'submodule.recurse=false'];
  if (checked.operation === 'git_branch_create') {
    // Atomic compare-and-set: no replacing a concurrently created ref and no
    // dereferencing a symbolic target ref. Does not switch the working tree.
    return [...common, 'update-ref', '--no-deref', 'refs/heads/' + checked.branch,
      checked.expectedHead, '0'.repeat(checked.expectedHead.length)];
  }
  return [...common, 'switch', '--no-guess', '--no-recurse-submodules',
    '--no-overwrite-ignore', '--', checked.branch];
}

export async function runGitBranchMutation(payload: unknown, adapter: GitBranchAdapter): Promise<{
  projectId: string; operation: GitBranchIntent['operation']; branch: string; head: string;
}> {
  const intent = parseGitBranchIntent(payload);
  const lease = await adapter.acquire(intent.projectId);
  // Fail closed for snapshot failures too: an adapter may have an uncertain
  // process tree. Only known preflight rejection or verified completion releases.
  let disposition: 'release' | 'quarantine' = 'quarantine';
  try {
    const before = await lease.snapshot(intent);
    disposition = 'release';
    checkGitBranchPreflight(intent, lease.approvedTargets, before);
    const args = gitBranchMutationArgs(intent, lease.emptyHooksDirectory);
    disposition = 'quarantine';
    await lease.run(args);
    const after = await lease.snapshot(intent);
    const create = intent.operation === 'git_branch_create';
    const head = create ? intent.expectedHead : intent.expectedTargetHead!;
    const currentBranch = create ? intent.expectedBranch : intent.branch;
    if (after.currentBranch !== currentBranch || after.head !== head ||
        after.targetHead !== head || after.clean !== true ||
        after.operationInProgress !== false || after.targetCheckedOutElsewhere !== false) {
      throw new Error('GIT_MUTATION_POSTCONDITION_UNCERTAIN');
    }
    disposition = 'release';
    return { projectId: intent.projectId, operation: intent.operation, branch: intent.branch, head };
  } finally {
    await lease.finish(disposition);
  }
}
