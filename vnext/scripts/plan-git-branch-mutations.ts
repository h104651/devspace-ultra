// Offline-only candidate. This module does not authorize or execute Git.
// The future isolated executor must obtain the snapshot under a workspace
// mutation lock, verify local policy and recheck it immediately before Git.
export type GitBranchIntent = {
  projectId: string;
  operation: 'git_branch_create' | 'git_switch';
  expectedBranch: string;
  expectedHead: string;
  branch: string;
  expectedTargetHead?: string;
};

export type GitBranchSnapshot = {
  currentBranch: string;
  head: string;
  clean: boolean;
  operationInProgress: boolean;
  targetHead: string | null;
  targetCheckedOutElsewhere: boolean;
};

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function branchName(value: unknown): string {
  // Deliberately narrower than Git ref syntax; no revision expressions,
  // shell syntax, option prefixes, case ambiguity or Windows aliases.
  if (typeof value !== 'string' || value.length > 128 ||
      !/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(value) ||
      value.split('/').some(part => /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(part))) {
    throw new Error('INVALID_GIT_BRANCH');
  }
  return value;
}

function oid(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || /^0+$/.test(value)) {
    throw new Error('INVALID_GIT_OBJECT_ID');
  }
  return value;
}

export function parseGitBranchIntent(payload: unknown): GitBranchIntent {
  if (!record(payload) || typeof payload.projectId !== 'string' ||
      !/^[a-z0-9_.-]{1,128}$/.test(payload.projectId) ||
      (payload.operation !== 'git_branch_create' && payload.operation !== 'git_switch')) {
    throw new Error('INVALID_GIT_BRANCH_INTENT');
  }
  const keys = ['projectId', 'operation', 'expectedBranch', 'expectedHead', 'branch'];
  if (payload.operation === 'git_switch') keys.push('expectedTargetHead');
  if (Object.keys(payload).some(key => !keys.includes(key)) ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(payload, key))) {
    throw new Error('INVALID_GIT_BRANCH_INTENT_FIELDS');
  }
  const expectedBranch = branchName(payload.expectedBranch);
  const branch = branchName(payload.branch);
  const expectedHead = oid(payload.expectedHead);
  if (branch === expectedBranch || !/^(?:feat|feature|fix|chore|test)\//.test(branch)) {
    throw new Error('GIT_BRANCH_TARGET_DENIED');
  }
  const intent: GitBranchIntent = { projectId: payload.projectId, operation: payload.operation, expectedBranch, expectedHead, branch };
  if (payload.operation === 'git_switch') {
    const expectedTargetHead = oid(payload.expectedTargetHead);
    if (expectedTargetHead.length !== expectedHead.length) throw new Error('GIT_OBJECT_FORMAT_MISMATCH');
    intent.expectedTargetHead = expectedTargetHead;
  }
  return intent;
}

// Exact locally approved target names only. No caller-provided policy,
// wildcard expansion, detached HEAD, dirty switch, implicit branch creation,
// overwriting refs, remote tracking, or automatic retry.
export function checkGitBranchPreflight(payload: unknown, approvedTargets: readonly string[], snapshot: GitBranchSnapshot): GitBranchIntent {
  const intent = parseGitBranchIntent(payload);
  if (!Array.isArray(approvedTargets) || !approvedTargets.includes(intent.branch)) {
    throw new Error('GIT_BRANCH_POLICY_DENIED');
  }
  if (!record(snapshot) || snapshot.currentBranch !== intent.expectedBranch || snapshot.head !== intent.expectedHead ||
      snapshot.clean !== true || snapshot.operationInProgress !== false || snapshot.targetCheckedOutElsewhere !== false) {
    throw new Error('GIT_BRANCH_STATE_CONFLICT');
  }
  if (intent.operation === 'git_branch_create' ? snapshot.targetHead !== null : snapshot.targetHead !== intent.expectedTargetHead) {
    throw new Error('GIT_BRANCH_TARGET_CONFLICT');
  }
  return intent;
}
