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
  const noHost=new TaskExecutor({projects,windowsAppContainerSid:sid});
  await assert.rejects(()=>noHost.executeTask(task,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
  const invalid=new TaskExecutor({projects,windowsJobRunnerPath:host,windowsAppContainerSid:'invalid'});
  await assert.rejects(()=>invalid.executeTask(task,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
  const held=new TaskExecutor({projects,windowsJobRunnerPath:host,windowsAppContainerSid:sid,hostExecutionBlocked:true});
  await assert.rejects(()=>held.executeTask(task,()=>{}),/LOCAL_EXECUTION_RUNTIME_BLOCKED/);
  console.log('OFFLINE_EXECUTOR_INTEGRATION PASS',process.arch);
}
main().catch(e=>{console.error(e);process.exitCode=1});
