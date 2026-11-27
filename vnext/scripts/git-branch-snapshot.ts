import * as fs from 'fs';
import * as path from 'path';
import { GitBranchIntent, GitBranchSnapshot, parseGitBranchIntent } from './plan-git-branch-mutations';

// Only the future isolated, bounded runner may implement this reader.
// It must return complete stdout (no stderr mixing), or throw. No host fallback.
export type GitSnapshotReader = (args: readonly string[]) => Promise<string>;

function existsEntry(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (err: any) { if (err.code === 'ENOENT') return false; throw err; }
}

function validateLocalConfig(output: string): void {
  if (!output.endsWith('\0')) throw new Error('GIT_CONFIG_SNAPSHOT_INVALID');
  const seen = new Set<string>();
  const booleanKeys = new Set(['core.filemode', 'core.logallrefupdates', 'core.ignorecase', 'core.symlinks']);
  for (const entry of output.slice(0, -1).split('\0')) {
    const split = entry.indexOf('\n');
    if (split < 1) throw new Error('GIT_CONFIG_SNAPSHOT_INVALID');
    const key = entry.slice(0, split).toLowerCase(), value = entry.slice(split + 1);
    if (seen.has(key)) throw new Error('GIT_CONFIG_POLICY_DENIED');
    seen.add(key);
    // Disposable SHA-1 staged repositories only. Deny includes, remotes,
    // aliases, hooks, extensions, external filters, fsmonitor and helpers.
    if (key === 'core.repositoryformatversion' && value === '0') continue;
    if (key === 'core.bare' && value === 'false') continue;
    if (booleanKeys.has(key) && /^(true|false)$/.test(value)) continue;
    if (key === 'commit.gpgsign' && value === 'false') continue;
    if ((key === 'user.name' || key === 'user.email') && /^[^\r\n\0]{1,200}$/.test(value)) continue;
    throw new Error('GIT_CONFIG_POLICY_DENIED');
  }
  if (!seen.has('core.repositoryformatversion') || !seen.has('core.bare')) throw new Error('GIT_CONFIG_POLICY_DENIED');
}

function assertDirectDirectory(dir: string): void {
  if (!path.isAbsolute(dir) || path.relative(path.resolve(dir), fs.realpathSync(dir)) !== '' ||
      !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('GIT_STAGED_DIRECTORY_DENIED');
  }
}

export async function collectGitBranchSnapshot(root: string, intent: GitBranchIntent, read: GitSnapshotReader): Promise<GitBranchSnapshot> {
  const checked = parseGitBranchIntent(intent);
  return collectStagedGitSnapshot(root, checked.expectedHead, checked.branch, read);
}

export async function collectStagedGitSnapshot(root: string, expectedHead: string, targetBranch: string, read: GitSnapshotReader): Promise<GitBranchSnapshot> {
  if (!/^[a-f0-9]{40}$/.test(expectedHead) || !/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(targetBranch)) {
    throw new Error('GIT_STAGED_OBJECT_FORMAT_DENIED');
  }
  assertDirectDirectory(root);
  const gitDir = path.join(root, '.git');
  assertDirectDirectory(gitDir);
  // Linked worktrees, alternate stores, shallow/partial repositories and
  // shared state are intentionally outside this first staging contract.
  for (const rel of ['commondir','gitdir','worktrees','shallow','objects/info/alternates','objects/info/http-alternates','info/grafts']) {
    if (existsEntry(path.join(gitDir,rel))) throw new Error('GIT_STAGED_REPOSITORY_DENIED');
  }
  const config = path.join(gitDir,'config');
  if (!fs.lstatSync(config).isFile() || fs.lstatSync(config).isSymbolicLink() ||
      path.relative(config,fs.realpathSync(config)) !== '') throw new Error('GIT_STAGED_CONFIG_DENIED');
  const common = ['--no-pager','--no-replace-objects','--literal-pathspecs','--git-dir=.git','--work-tree=.',
    '-c','protocol.allow=never','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','submodule.recurse=false'];
  const query = (args: string[]) => read([...common,...args]);
  validateLocalConfig(await query(['config','--local','--no-includes','--null','--list']));
  const operationInProgress = ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','BISECT_START',
    'rebase-merge','rebase-apply','sequencer','index.lock','HEAD.lock','packed-refs.lock'].some(rel=>existsEntry(path.join(gitDir,rel)));
  const currentRef = (await query(['symbolic-ref','--no-recurse','HEAD'])).trim();
  if (!currentRef.startsWith('refs/heads/')) throw new Error('GIT_STAGED_HEAD_DENIED');
  const head = (await query(['rev-parse','--verify','HEAD^{commit}'])).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('GIT_STAGED_HEAD_DENIED');
  const target = 'refs/heads/' + targetBranch;
  let targetHead: string | null = null;
  let currentFound = false;
  const refs = await query(['for-each-ref','--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)','refs/heads']);
  for (const row of refs.split(/\r?\n/).filter(Boolean)) {
    const fields = row.split('\0');
    if (fields.length !== 4) throw new Error('GIT_STAGED_REFS_INVALID');
    const [ref, hash, symref, type] = fields;
    if (ref === currentRef) {
      if (symref || type !== 'commit' || hash !== head) throw new Error('GIT_STAGED_HEAD_DENIED');
      currentFound = true;
    }
    const lower = ref.toLowerCase(), desired = target.toLowerCase();
    if (ref === target) {
      if (targetHead !== null || symref || type !== 'commit' || !/^[a-f0-9]{40}$/.test(hash)) throw new Error('GIT_STAGED_TARGET_DENIED');
      targetHead = hash;
    } else if (lower === desired || lower.startsWith(desired + '/') || desired.startsWith(lower + '/')) {
      throw new Error('GIT_STAGED_TARGET_COLLISION');
    }
  }
  if (!currentFound) throw new Error('GIT_STAGED_HEAD_DENIED');
  const status = await query(['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching','--ignore-submodules=none']);
  return { currentBranch:currentRef.slice('refs/heads/'.length), head, clean:status === '',
    operationInProgress, targetHead, targetCheckedOutElsewhere:false };
}
