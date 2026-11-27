import { authorizeGitNetworkIntent, parseGitNetworkIntent, GitNetworkIntent, GitNetworkPolicy, GitNetworkSnapshot, validateGitNetworkEndpoint } from './plan-git-network';

// Internal broker interface, not a remote input or a credential container.
// The eventual transport must pin the actual endpoint, enforce network and
// credential isolation, and implement remote compare-and-set without force.
export interface GitNetworkLease {
  readonly policy: GitNetworkPolicy;
  observe(intent: GitNetworkIntent, endpoint: string, ref: string): Promise<GitNetworkSnapshot>;
  fetchPinned(endpoint:string, ref:string, expectedRemoteHead:string):Promise<void>;
  fastForward(expectedLocalHead:string, expectedRemoteHead:string):Promise<void>;
  pushFastForwardCas(endpoint:string, ref:string, expectedRemoteHead:string, expectedLocalHead:string):Promise<void>;
  hasFetchedObject(head:string):Promise<boolean>;
  finish(disposition:'release'|'quarantine'):Promise<void>;
}
export interface GitNetworkBroker {
  acquire(projectId:string):Promise<GitNetworkLease>;
}

// All operations are fenced. Only a successful, verified outcome releases
// after execution begins. The transport receives resolved local policy data,
// not arbitrary caller URL, refspec, credentials or command arguments.
export async function executeGitNetworkIntent(payload:unknown, broker:GitNetworkBroker):Promise<{
  operation:GitNetworkIntent['operation']; localHead:string; remoteHead:string
}> {
  const intent=parseGitNetworkIntent(payload);
  const lease=await broker.acquire(intent.projectId);
  let disposition:'release'|'quarantine'='quarantine';
  try {
    // Resolve and verify the approved endpoint *before* network observation.
    const matches=lease.policy.remotes.filter(r=>r.id===intent.remoteId);
    if(lease.policy.projectId!==intent.projectId || matches.length!==1 ||
       !matches[0].approvedBranches.includes(intent.branch) || !matches[0].operations.includes(intent.operation)) {
      disposition='release';
      throw new Error('GIT_NETWORK_POLICY_DENIED');
    }
    const endpoint=validateGitNetworkEndpoint(matches[0].url);
    const ref='refs/heads/'+intent.branch;
    const before=await lease.observe(intent,endpoint,ref);
    disposition='release';
    if(intent.operation==='git_pull_ff') {
      // The remote object may not exist locally yet. Check pinned identity and
      // clean state before fetching; prove ancestry only after pinned fetch.
      if(before.currentBranch!==intent.branch || before.localHead!==intent.expectedLocalHead ||
         before.remoteHead!==intent.expectedRemoteHead || before.operationInProgress!==false) throw new Error('GIT_NETWORK_STATE_CONFLICT');
      if(before.clean!==true) throw new Error('GIT_NETWORK_NOT_FAST_FORWARD');
    } else authorizeGitNetworkIntent(intent,lease.policy,before);
    disposition='quarantine';
    if(intent.operation==='git_fetch' || intent.operation==='git_pull_ff') {
      await lease.fetchPinned(endpoint,ref,intent.expectedRemoteHead);
      if(!await lease.hasFetchedObject(intent.expectedRemoteHead)) throw new Error('GIT_NETWORK_FETCH_UNCERTAIN');
      if(intent.operation==='git_pull_ff') {
        const fetched=await lease.observe(intent,endpoint,ref);
        authorizeGitNetworkIntent(intent,lease.policy,fetched);
        await lease.fastForward(intent.expectedLocalHead,intent.expectedRemoteHead);
      }
    } else {
      await lease.pushFastForwardCas(endpoint,ref,intent.expectedRemoteHead,intent.expectedLocalHead);
    }
    const after=await lease.observe(intent,endpoint,ref);
    const localHead=intent.operation==='git_pull_ff'?intent.expectedRemoteHead:intent.expectedLocalHead;
    const remoteHead=intent.operation==='git_push'?intent.expectedLocalHead:intent.expectedRemoteHead;
    if(after.currentBranch!==intent.branch || after.localHead!==localHead ||
       after.remoteHead!==remoteHead || after.operationInProgress!==false ||
       (intent.operation!=='git_fetch' && after.clean!==true) ||
       (intent.operation==='git_fetch' && after.clean!==before.clean)) throw new Error('GIT_NETWORK_POSTCONDITION_UNCERTAIN');
    disposition='release';
    return {operation:intent.operation,localHead,remoteHead};
  } finally {await lease.finish(disposition);}
}
