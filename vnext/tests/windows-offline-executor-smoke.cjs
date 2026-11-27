// Trusted hosted CI orchestration; no task-supplied launch configuration.
const assert = require('node:assert/strict');
const path = require('node:path');
const { TaskExecutor } = require('../dist/local-agent/task-executor');
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  const [host,root,sid,port] = process.argv.slice(2);
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
  console.log('OFFLINE_EXECUTOR_INTEGRATION PASS',process.arch);
}
main().catch(e=>{console.error(e);process.exitCode=1});
