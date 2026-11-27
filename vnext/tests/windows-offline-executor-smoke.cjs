// Trusted hosted CI orchestration; no task-supplied launch configuration.
const assert = require('node:assert/strict');
const path = require('node:path');
const { TaskExecutor } = require('../dist/local-agent/task-executor');
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const [host,root,sid,port,hostGit] = process.argv.slice(2);
  const work=path.join(root,'work');
  const projects=[{projectId:'fixture',root:work,permissions:{read:true,test:true,hostExecution:true},commands:{test:{offline:{
    executable:path.join(root,'tool','node.exe'),
    args:['--preserve-symlinks-main',path.join(root,'tool','Probe.cjs'),root,port],timeoutMs:30000
  }}}}];
  const executor=new TaskExecutor({projects,windowsJobRunnerPath:host,windowsAppContainerSid:sid});
  const task={capability:'local:run_tests',payload:{projectId:'fixture',runnerId:'offline'}};
  const result=await executor.executeTask(task,()=>{});
  assert.equal(result.exitCode,0);
  assert.match(result.stdout,/NATIVE_RUNNER_OFFLINE_TOKEN_VERIFIED/);
  const isolated=await executor.executeProcessWithoutShell(path.join(root,'tool','node.exe'),
    ['-e',"process.stdout.write('fixture\\0');process.stderr.write('diagnostic')"],work,undefined,()=>{},10000,undefined,true);
  assert.equal(isolated.stdout,'fixture\0');
  assert.equal(isolated.outputTruncated,false);
  const bounded=await executor.executeProcessWithoutShell(path.join(root,'tool','node.exe'),
    ['-e',"process.stderr.write('x'.repeat(270000));process.stdout.write('fixture')"],work,undefined,()=>{},10000,undefined,true);
  assert.equal(bounded.outputTruncated,true);
  const noHost=new TaskExecutor({projects,windowsAppContainerSid:sid});
  await assert.rejects(()=>noHost.executeTask(task,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
  const invalid=new TaskExecutor({projects,windowsJobRunnerPath:host,windowsAppContainerSid:'invalid'});
  await assert.rejects(()=>invalid.executeTask(task,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
  const held=new TaskExecutor({projects,windowsJobRunnerPath:host,windowsAppContainerSid:sid,hostExecutionBlocked:true});
  await assert.rejects(()=>held.executeTask(task,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
  const raw=new TaskExecutor({projects,windowsJobRunnerPath:host,windowsAppContainerSid:sid,allowRawShell:true});
  await assert.rejects(()=>raw.executeTask({capability:'local:raw_shell',payload:{projectId:'fixture',command:'echo fixture'}},()=>{}),/RAW_SHELL_DENIED/);
  const extraProjects=JSON.parse(JSON.stringify(projects));
  extraProjects[0].commands.test.offline.env={HOME:work};
  const extra=new TaskExecutor({projects:extraProjects,windowsJobRunnerPath:host,windowsAppContainerSid:sid});
  await assert.rejects(()=>extra.executeTask(task,()=>{}),/LOCAL_RUNNER_ENV_DENIED/);
  // Reserved Git IDs cannot smuggle non-Git verbs or omit the bounded timeout.
  // A synthetic file tests rejection before any Git process can start.
  const fs=require('node:fs');
  const stagedGit=path.join(root,'work','git.exe');
  fs.writeFileSync(stagedGit,'fixture-not-executable');
  const gitProfiles={git_log:{executable:stagedGit,args:['push','origin','main'],timeoutMs:30000}};
  const gitProject={projectId:'git-fixture',root:work,permissions:{read:true,test:true,hostExecution:true},commands:{test:gitProfiles}};
  const gitTask={capability:'local:run_tests',payload:{projectId:'git-fixture',runnerId:'git_log'}};
  const gitExecutor=new TaskExecutor({projects:[gitProject],windowsJobRunnerPath:host,windowsAppContainerSid:sid});
  await assert.rejects(()=>gitExecutor.executeTask(gitTask,()=>{}),/LOCAL_GIT_PROFILE_DENIED/);
  delete gitProfiles.git_log.timeoutMs;
  const missingTimeout=new TaskExecutor({projects:[gitProject],windowsJobRunnerPath:host,windowsAppContainerSid:sid});
  await assert.rejects(()=>missingTimeout.executeTask(gitTask,()=>{}),/LOCAL_GIT_PROFILE_DENIED/);
  gitProject.permissions.read=false;
  const noRead=new TaskExecutor({projects:[gitProject],windowsJobRunnerPath:host,windowsAppContainerSid:sid});
  await assert.rejects(()=>noRead.executeTask(gitTask,()=>{}),/LOCAL_PROJECT_PERMISSION_DENIED/);
  fs.unlinkSync(stagedGit);
  // Real Git-for-Windows through the same zero-capability native runner.
  // Host Git is used only to provision and independently inspect the synthetic repo.
  require('ts-node/register');
  const {createNativeStagedGitAdapter}=require('../scripts/native-staged-git-adapter');
  const {runGitBranchMutation}=require('../scripts/execute-git-branch-mutations');
  const {runGitIndexMutation}=require('../scripts/execute-git-index-mutations');
  const {buildGitReadArgs}=require('../dist/local-agent/git-read-plan');
  const {execFileSync}=require('node:child_process');
  const crypto=require('node:crypto');
  const repo=path.join(work,'git-repo');
  fs.mkdirSync(repo);
  const canon=p=>fs.realpathSync(p);
  const prefix=path.basename(path.dirname(path.dirname(hostGit)));
  assert.ok(['mingw64','clangarm64'].includes(prefix),'Unexpected hosted Git prefix');
  const executable=canon(path.join(root,'tool','git-dist',prefix,'bin','git.exe'));
  const image=fs.readFileSync(executable);
  assert.equal(image.readUInt16LE(0),0x5a4d);
  const pe=image.readUInt32LE(0x3c);
  assert.equal(image.readUInt32LE(pe),0x4550);
  const machine=image.readUInt16LE(pe+4);
  const expectedMachine=process.arch==='arm64'?0xaa64:0x8664;
  assert.equal(machine,expectedMachine,'Hosted Git distribution must match native runner architecture');
  console.log('STAGED_GIT_NATIVE_ARCH PASS',process.arch);
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'};
  for(const key of Object.keys(env)) if(key.startsWith('GIT_')&&!['GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_OPTIONAL_LOCKS','GIT_NO_LAZY_FETCH','GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
  const git=args=>execFileSync(hostGit,args,{cwd:repo,env,encoding:'utf8',timeout:10000,maxBuffer:262144});
  git(['init','-q','-b','main','--object-format=sha1','--template=']);
  git(['config','user.name','Synthetic Fixture']);
  git(['config','user.email','fixture@example.invalid']);
  git(['config','commit.gpgsign','false']);
  fs.writeFileSync(path.join(repo,'fixture.txt'),'before\n');
  git(['add','fixture.txt']);git(['commit','-qm','initial']);
  const head=git(['rev-parse','HEAD']).trim();
  const policy={projectId:'native-git-fixture',root:canon(repo),executable,
    emptyHooksDirectory:canon(path.join(root,'tool','empty-hooks')),
    protectedFenceDirectory:canon(path.join(root,'protected')),
    approvedTargets:['feat/native-fixture'],approvedPaths:['fixture.txt'],timeoutMs:10000};
  const actual=new TaskExecutor({projects:[{projectId:policy.projectId,root:repo,permissions:{read:true,test:true,hostExecution:true},commands:{test:{git_log:{
    executable,args:buildGitReadArgs('git_log',{head,limit:1}),timeoutMs:10000
  }}}}],windowsJobRunnerPath:host,windowsAppContainerSid:sid});
  // Fixture-only observation of the exact compiled runner. Keep diagnostics
  // separate from machine-readable stdout and print only on synthetic failure.
  // Never add arbitrary remote task output or credentials to this diagnostic.
  const originalRun=actual.executeProcessWithoutShell.bind(actual);
  let sequence=0;
  actual.executeProcessWithoutShell=async (exe,args,cwd,extra,onLog,timeout,signal,stdoutOnly)=>{
    assert.equal(exe,executable);
    const number=++sequence;
    const verb=args[0]==='--version'?'version':
      args.find(a=>['log','config','symbolic-ref','rev-parse','for-each-ref','ls-tree','status','update-ref','switch','diff','add','ls-files','write-tree','commit-tree','show'].includes(a))||'other';
    const diagnostics=[];
    let size=0;
    console.log('STAGED_GIT_STEP BEGIN',number,verb);
    try {
      const result=await originalRun(exe,args,cwd,extra,line=>{
        if(line.startsWith('[STDERR]')&&size<4096) {
          const accepted=line.slice(0,4096-size); diagnostics.push(accepted);size+=accepted.length;
        }
        onLog(line);
      },timeout,signal,stdoutOnly);
      console.log('STAGED_GIT_STEP PASS',number,verb);
      return result;
    } catch(error) {
      console.error('STAGED_GIT_STEP FAIL',number,verb,diagnostics.join('\n'));
      throw error;
    }
  };
  // Verify relocation separately from the zero-capability execution.
  // Use the same allowlisted minimal environment and exact staged image;
  // this host-side probe is only the fixed --version command on hosted CI.
  const minimal={SystemRoot:process.env.SystemRoot||process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,
    PATH:path.dirname(executable)+';'+path.join(process.env.SystemRoot||process.env.SYSTEMROOT,'System32'),
    USERPROFILE:repo,APPDATA:repo,LOCALAPPDATA:repo,TEMP:repo,TMP:repo,
    GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
  const relocatedVersion=execFileSync(executable,['--version'],{cwd:repo,env:minimal,encoding:'utf8',timeout:10000,maxBuffer:262144});
  assert.match(relocatedVersion,/^git version /);
  console.log('STAGED_GIT_HOST_RELOCATION PASS',process.arch);
  const version=await actual.runStagedGitCandidate(executable,['--version'],policy.root,10000);
  assert.match(version,/^git version /);
  const read=await actual.executeTask({capability:'local:git_read',payload:{projectId:policy.projectId,operation:'git_log',head,limit:1}},()=>{});
  assert.ok(read.stdout.includes(head));
  assert.ok(!read.stdout.includes('NATIVE_RUNNER_OFFLINE_TOKEN_VERIFIED'));
  const adapter=createNativeStagedGitAdapter(actual,policy);
  const create={projectId:policy.projectId,operation:'git_branch_create',expectedBranch:'main',expectedHead:head,branch:'feat/native-fixture'};
  await runGitBranchMutation(create,adapter);
  assert.equal(git(['rev-parse','refs/heads/feat/native-fixture']).trim(),head);
  await runGitBranchMutation({...create,operation:'git_switch',expectedTargetHead:head},adapter);
  assert.equal(git(['symbolic-ref','--short','HEAD']).trim(),'feat/native-fixture');
  fs.writeFileSync(path.join(repo,'fixture.txt'),'after\n');
  const stage=await runGitIndexMutation({projectId:policy.projectId,operation:'git_stage',branch:create.branch,expectedHead:head,
    files:[{path:'fixture.txt',sha256:crypto.createHash('sha256').update('after\n').digest('hex')}]},adapter);
  const commit=await runGitIndexMutation({projectId:policy.projectId,operation:'git_commit',branch:create.branch,expectedHead:head,
    paths:['fixture.txt'],expectedTree:stage.tree,message:'native fixture update'},adapter);
  assert.equal(git(['rev-parse','HEAD']).trim(),commit.head);
  assert.equal(git(['rev-parse','HEAD^']).trim(),head);
  assert.equal(git(['show','HEAD:fixture.txt']),'after\n');
  assert.equal(git(['status','--porcelain']),'');
  assert.equal(fs.existsSync(path.join(policy.protectedFenceDirectory,'git-mutation.lock')),false);
  console.log('APPCONTAINER_REAL_GIT_MUTATION PASS',process.arch);
  console.log('OFFLINE_EXECUTOR_INTEGRATION PASS',process.arch);
}
main().catch(e=>{console.error(e);process.exitCode=1});
