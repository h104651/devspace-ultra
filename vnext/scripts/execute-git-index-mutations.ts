import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { GitBranchAdapter } from './execute-git-branch-mutations';
import { collectStagedGitSnapshot } from './git-branch-snapshot';

type FileSelection = { path: string; sha256: string };
type Intent = {
  projectId: string; branch: string; expectedHead: string;
  operation: 'git_stage' | 'git_commit'; files?: FileSelection[];
  paths?: string[]; expectedTree?: string; message?: string;
};

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, any>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(k=>!Object.prototype.hasOwnProperty.call(value,k))) throw new Error('GIT_INDEX_FIELDS_DENIED');
}
function safePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 240 ||
      !/^[A-Za-z0-9_-][A-Za-z0-9_. -]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_. -]*)*$/.test(value) ||
      value.split('/').some(p=>/[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new Error('GIT_INDEX_PATH_DENIED');
  }
  return value;
}
function oid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) throw new Error('GIT_INDEX_OID_DENIED');
  return value;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error('GIT_INDEX_PATH_COUNT_DENIED');
  const result=value.map(safePath);
  if (new Set(result.map(p=>p.toLowerCase())).size !== result.length) throw new Error('GIT_INDEX_DUPLICATE_PATH');
  return result;
}
export function parseGitIndexIntent(payload: unknown): Intent {
  if (!object(payload) || typeof payload.projectId !== 'string' || !/^[a-z0-9_.-]{1,128}$/.test(payload.projectId) ||
      typeof payload.branch !== 'string' || payload.branch.length > 128 ||
      !/^(?:feat|feature|fix|chore|test)\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(payload.branch) ||
      payload.branch.split('/').some(p=>/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(p))) throw new Error('GIT_INDEX_INTENT_DENIED');
  const base = { projectId:payload.projectId, branch:payload.branch, expectedHead:oid(payload.expectedHead) };
  if (payload.operation === 'git_stage') {
    exact(payload,['projectId','branch','expectedHead','operation','files']);
    if (!Array.isArray(payload.files)) throw new Error('GIT_INDEX_FIELDS_DENIED');
    const files: FileSelection[] = payload.files.map(f=>{
      if (!object(f)) throw new Error('GIT_INDEX_FIELDS_DENIED');
      exact(f,['path','sha256']);
      if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('GIT_INDEX_HASH_DENIED');
      return {path:safePath(f.path),sha256:f.sha256};
    });
    paths(files.map(f=>f.path));
    return {...base,operation:'git_stage',files};
  }
  if (payload.operation === 'git_commit') {
    exact(payload,['projectId','branch','expectedHead','operation','paths','expectedTree','message']);
    if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(payload.message)) throw new Error('GIT_COMMIT_MESSAGE_DENIED');
    return {...base,operation:'git_commit',paths:paths(payload.paths),expectedTree:oid(payload.expectedTree),message:payload.message};
  }
  throw new Error('GIT_INDEX_INTENT_DENIED');
}

function selectedBlob(root: string, selection: FileSelection): string {
  let current=root;
  for (const part of selection.path.split('/')) {
    current=path.join(current,part);
    if (fs.lstatSync(current).isSymbolicLink() || path.relative(current,fs.realpathSync(current)) !== '') throw new Error('GIT_INDEX_PATH_DENIED');
  }
  const stat=fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16*1024*1024) throw new Error('GIT_INDEX_FILE_DENIED');
  const content=fs.readFileSync(current);
  if (content.length !== stat.size || crypto.createHash('sha256').update(content).digest('hex') !== selection.sha256) throw new Error('GIT_INDEX_CONTENT_CHANGED');
  return crypto.createHash('sha1').update('blob '+content.length+'\0').update(content).digest('hex');
}
function samePaths(actual: string[], expected: string[]): boolean {
  return actual.length===expected.length && [...actual].sort().every((v,i)=>v===[...expected].sort()[i]);
}
function parseNul(value: string): string[] {
  if (value === '') return [];
  if (!value.endsWith('\0')) throw new Error('GIT_INDEX_OUTPUT_INVALID');
  return value.slice(0,-1).split('\0');
}

// Offline candidate; adapter must enforce exclusive staged workspace,
// protected local policy, strict stdout-only bounded Git and process drain.
// No MCP exposure, network, signing, arbitrary Git arguments or staging deletes.
export async function runGitIndexMutation(payload: unknown, adapter: GitBranchAdapter): Promise<{operation: Intent['operation']; branch: string; head: string; tree: string; paths: string[]}> {
  const intent=parseGitIndexIntent(payload);
  const lease=await adapter.acquire(intent.projectId);
  let disposition: 'release'|'quarantine'='quarantine';
  try {
    const workspace=lease.indexWorkspace;
    if (!workspace || !lease.query || !lease.approvedTargets.includes(intent.branch) ||
        !path.isAbsolute(lease.emptyHooksDirectory)) throw new Error('GIT_INDEX_POLICY_DENIED');
    const selected=intent.files?.map(f=>f.path) || intent.paths!;
    if (selected.some(p=>!workspace.approvedPaths.includes(p))) throw new Error('GIT_INDEX_POLICY_DENIED');
    const common=['--no-pager','--no-replace-objects','--literal-pathspecs','--git-dir=.git','--work-tree=.',
      '-c','protocol.allow=never','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false',
      '-c','core.hooksPath='+lease.emptyHooksDirectory,'-c','submodule.recurse=false','-c','commit.gpgsign=false'];
    const query=(args:string[])=>lease.query!([...common,...args]);
    const snapshot=()=>collectStagedGitSnapshot(workspace.root,intent.expectedHead,intent.branch,lease.query!.bind(lease));
    const before=await snapshot();
    const staged=()=>query(['diff','--cached','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv','--']).then(parseNul);
    const previous=await staged();
    disposition='release';
    if (before.currentBranch!==intent.branch || before.head!==intent.expectedHead || before.targetHead!==intent.expectedHead ||
        before.operationInProgress || before.targetCheckedOutElsewhere) throw new Error('GIT_INDEX_STATE_CONFLICT');
    if (intent.operation==='git_stage') {
      if (previous.length) throw new Error('GIT_INDEX_NOT_EMPTY');
      const blobs=intent.files!.map(f=>selectedBlob(workspace.root,f));
      disposition='quarantine';
      // Explicit path list only, no globbing or recursive directory staging.
      await lease.run([...common,'add','--',...selected]);
      if (!samePaths(await staged(),selected)) throw new Error('GIT_INDEX_POSTCONDITION_UNCERTAIN');
      for(let i=0;i<selected.length;i++) {
        const entries=parseNul(await query(['ls-files','--stage','-z','--',selected[i]]));
        if(entries.length!==1 || !/^(100644|100755) [a-f0-9]{40} 0\t/.test(entries[0]) ||
            entries[0].split('\t')[1]!==selected[i] || entries[0].split(' ')[1]!==blobs[i]) throw new Error('GIT_INDEX_BLOB_MISMATCH');
      }
      const tree=oid((await query(['write-tree'])).trim());
      const after=await snapshot();
      if(after.currentBranch!==intent.branch || after.head!==intent.expectedHead || after.targetHead!==intent.expectedHead || after.operationInProgress) throw new Error('GIT_INDEX_POSTCONDITION_UNCERTAIN');
      disposition='release';
      return {operation:intent.operation,branch:intent.branch,head:intent.expectedHead,tree,paths:selected};
    }
    if (!samePaths(previous,selected)) throw new Error('GIT_COMMIT_PATHS_CHANGED');
    // write-tree may write objects: from this point failures retain the fence.
    disposition='quarantine';
    const tree=oid((await query(['write-tree'])).trim());
    if(tree!==intent.expectedTree) throw new Error('GIT_COMMIT_TREE_CHANGED');
    // Commit only the pinned index tree; explicit parent and local identity.
    const head=oid((await query(['commit-tree',tree,'-p',intent.expectedHead,'-m',intent.message!])).trim());
    await lease.run([...common,'update-ref','--no-deref','refs/heads/'+intent.branch,head,intent.expectedHead]);
    const after=await snapshot();
    const actual=(await query(['show','-s','--format=%H%x09%T%x09%P','--no-show-signature',head,'--'])).trim();
    if(after.currentBranch!==intent.branch || after.head!==head || after.targetHead!==head || after.operationInProgress ||
        actual!==[head,tree,intent.expectedHead].join('\t') || (await staged()).length!==0) throw new Error('GIT_COMMIT_POSTCONDITION_UNCERTAIN');
    disposition='release';
    return {operation:intent.operation,branch:intent.branch,head,tree,paths:selected};
  } finally { await lease.finish(disposition); }
}
