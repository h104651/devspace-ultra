// Candidate network admission contract only. No network or credentials here.
// A separate broker must enforce the exact HTTPS endpoint and no redirects,
// explicit authentication and remote ref compare-and-set, independently of
// the existing offline zero-capability Job Runner.
export interface GitNetworkIntent {
  projectId: string;
  operation: 'git_fetch'|'git_pull_ff'|'git_push';
  remoteId: string;
  branch: string;
  expectedLocalHead: string;
  expectedRemoteHead: string;
}
export interface GitNetworkPolicy {
  projectId: string;
  remotes: readonly {id:string; url:string; approvedBranches:readonly string[]; operations:readonly GitNetworkIntent['operation'][]}[];
}
export interface GitNetworkSnapshot {
  currentBranch: string;
  localHead: string;
  remoteHead: string;
  clean: boolean;
  operationInProgress: boolean;
  // These must come from the trusted broker/validated local object graph,
  // not the MCP task or a caller-supplied assertion.
  localIsAncestorOfRemote: boolean;
  remoteIsAncestorOfLocal: boolean;
}
function oid(v:unknown): v is string {return typeof v==='string' && /^[a-f0-9]{40}$/.test(v) && !/^0+$/.test(v);}
function id(v:unknown): v is string {return typeof v==='string'&&/^[a-z0-9_.-]{1,128}$/.test(v);}
export function parseGitNetworkIntent(value:unknown):GitNetworkIntent {
  if (!value || typeof value!=='object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)) throw new Error('GIT_NETWORK_INTENT_DENIED');
  const v=value as Record<string,any>;
  const keys=['projectId','operation','remoteId','branch','expectedLocalHead','expectedRemoteHead'];
  if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.prototype.hasOwnProperty.call(v,k))||
     !id(v.projectId)||!id(v.remoteId)||!['git_fetch','git_pull_ff','git_push'].includes(v.operation)||
     typeof v.branch!=='string'||v.branch.length>128||
     !/^(?:feat|feature|fix|chore|test)\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/.test(v.branch)||
     v.branch.split('/').some((p:string)=>/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(p))||
     !oid(v.expectedLocalHead)||!oid(v.expectedRemoteHead)) throw new Error('GIT_NETWORK_INTENT_DENIED');
  return {projectId:v.projectId,operation:v.operation,remoteId:v.remoteId,branch:v.branch,
    expectedLocalHead:v.expectedLocalHead,expectedRemoteHead:v.expectedRemoteHead};
}
export function validateGitNetworkEndpoint(raw:string):string {
  // Exact canonical HTTPS DNS endpoint, no userinfo, IP literals, custom port,
  // encoded path, query, fragment, dot segments, credential helper or SSH.
  if(typeof raw!=='string'||raw.length>512||
     !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+\.git$/.test(raw)) throw new Error('GIT_NETWORK_ENDPOINT_DENIED');
  const url=new URL(raw);
  if(url.href!==raw||!url.hostname.includes('.')||/^[0-9.]+$/.test(url.hostname)||
     url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||
     url.hostname.split('.').some(p=>!p||p.startsWith('-')||p.endsWith('-'))||
     url.pathname.split('/').some(p=>p==='.'||p==='..'||p.endsWith('.'))) throw new Error('GIT_NETWORK_ENDPOINT_DENIED');
  // DNS resolution, proxy isolation, TLS and actual destination validation
  // are broker responsibilities, not established by this syntax check.
  return raw;
}
export function authorizeGitNetworkIntent(payload:unknown,policy:GitNetworkPolicy,state:GitNetworkSnapshot):{intent:GitNetworkIntent;endpoint:string;ref:string} {
  const intent=parseGitNetworkIntent(payload);
  const matching=policy.remotes.filter(r=>r.id===intent.remoteId);
  if(policy.projectId!==intent.projectId||matching.length!==1||!matching[0].approvedBranches.includes(intent.branch)||
     !matching[0].operations.includes(intent.operation)) throw new Error('GIT_NETWORK_POLICY_DENIED');
  const endpoint=validateGitNetworkEndpoint(matching[0].url);
  if(state.currentBranch!==intent.branch||state.localHead!==intent.expectedLocalHead||
     state.remoteHead!==intent.expectedRemoteHead||state.operationInProgress!==false) throw new Error('GIT_NETWORK_STATE_CONFLICT');
  if(intent.operation==='git_pull_ff'&&(state.clean!==true||state.localIsAncestorOfRemote!==true)) throw new Error('GIT_NETWORK_NOT_FAST_FORWARD');
  if(intent.operation==='git_push'&&(state.clean!==true||state.remoteIsAncestorOfLocal!==true)) throw new Error('GIT_NETWORK_NOT_FAST_FORWARD');
  return {intent,endpoint,ref:'refs/heads/'+intent.branch};
}
