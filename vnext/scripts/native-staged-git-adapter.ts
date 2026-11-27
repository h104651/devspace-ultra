import * as fs from 'fs';
import * as path from 'path';
import { TaskExecutor } from '../src/local-agent/task-executor';
import { GitBranchAdapter } from './execute-git-branch-mutations';
import { withDurableGitFence } from './git-mutation-fence';
import { collectGitBranchSnapshot } from './git-branch-snapshot';

// Trusted local provisioning input, not a task payload. This candidate does
// not create ACLs or activate Agent capabilities. Only use a separately
// provisioned disposable staged workspace with exclusive write ownership.
export interface StagedGitPolicy {
  projectId: string;
  root: string;
  executable: string;
  emptyHooksDirectory: string;
  protectedFenceDirectory: string;
  approvedTargets: readonly string[];
  approvedPaths: readonly string[];
  timeoutMs: number;
}

function canonical(input: string, directory: boolean): string {
  if (!path.isAbsolute(input)) throw new Error('GIT_STAGED_POLICY_PATH_DENIED');
  const real=fs.realpathSync(input), stat=fs.lstatSync(input);
  if (path.relative(path.resolve(input),real)!=='' || stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('GIT_STAGED_POLICY_PATH_DENIED');
  return real;
}
function contains(root: string, candidate: string): boolean {
  const rel=path.relative(root,candidate);
  return rel==='' || (!path.isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+path.sep));
}
export function createNativeStagedGitAdapter(executor: TaskExecutor, policy: StagedGitPolicy, signal?: AbortSignal): GitBranchAdapter {
  if (process.platform!=='win32' || executor.isHostExecutionBlocked()) throw new Error('LOCAL_EXECUTION_RUNTIME_BLOCKED: Native staged Git adapter requires an unblocked Windows candidate.');
  if (!/^[a-z0-9_.-]{1,128}$/.test(policy.projectId) || !Number.isInteger(policy.timeoutMs) ||
      policy.timeoutMs<100 || policy.timeoutMs>30000) throw new Error('GIT_STAGED_POLICY_DENIED');
  const root=canonical(policy.root,true), executable=canonical(policy.executable,false);
  const hooks=canonical(policy.emptyHooksDirectory,true), fence=canonical(policy.protectedFenceDirectory,true);
  if (path.basename(executable).toLowerCase()!=='git.exe' || fs.readdirSync(hooks).length ||
      [hooks,fence,executable].some(p=>contains(root,p)) || contains(hooks,fence) || contains(fence,hooks)) {
    throw new Error('GIT_STAGED_POLICY_PATH_DENIED');
  }
  const approvedTargets=Object.freeze([...policy.approvedTargets]), approvedPaths=Object.freeze([...policy.approvedPaths]);
  const query=async (args: readonly string[])=>{
    if (fs.readdirSync(hooks).length || canonical(hooks,true)!==hooks || canonical(root,true)!==root ||
        canonical(executable,false)!==executable) throw new Error('GIT_STAGED_POLICY_CHANGED');
    return executor.runStagedGitCandidate(executable,args,root,policy.timeoutMs,signal);
  };
  const inner: GitBranchAdapter={async acquire(projectId){
    if (projectId!==policy.projectId || executor.isHostExecutionBlocked()) throw new Error('GIT_STAGED_POLICY_DENIED');
    return {
      approvedTargets, emptyHooksDirectory:hooks,indexWorkspace:{root,approvedPaths},
      snapshot(intent){return collectGitBranchSnapshot(root,intent,query);},
      query,async run(args){await query(args);},async finish(){}
    };
  }};
  // Policy must be validated before creating a durable fence; otherwise a
  // malformed project ID can poison the lock directory without execution.
  const fenced=withDurableGitFence(fence,inner);
  return {async acquire(projectId){
    if (projectId!==policy.projectId || executor.isHostExecutionBlocked()) throw new Error('GIT_STAGED_POLICY_DENIED');
    return fenced.acquire(projectId);
  }};
}
