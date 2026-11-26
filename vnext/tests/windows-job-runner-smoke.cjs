// Compiled TS -> native runtime integration using only disposable fixture data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskExecutor } = require('../dist/local-agent/task-executor');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (e) { if (e.code !== 'ESRCH') throw e; return true; }
}
async function waitMarker(file) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const pids = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(pids.parent) && Number.isInteger(pids.child)) return pids;
    } catch {}
    await sleep(25);
  }
  throw new Error('Fixture child never became ready');
}
async function main() {
  assert.equal(process.platform, 'win32');
  const host = path.resolve(process.argv[2]);
  assert.ok(fs.existsSync(host));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu~job smoke '));
  try {
    const marker = path.join(root, 'pids.json');
    const native = process.execPath;
    const wrapper = path.join(root, 'fixture wrapper.cmd');
    fs.writeFileSync(wrapper, '@echo off\r\nif not "%~1"=="test argument" exit /b 19\r\necho contained-wrapper-ok\r\n');
    const tree = "const fs=require('node:fs');const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);";
    const profiles = {
      good: { executable: native, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'with space', 'quote"and\\', ''], timeoutMs: 10000 },
      wrapper: { executable: wrapper, args: ['test argument'], timeoutMs: 10000 },
      fail: { executable: native, args: ['-e', 'process.exit(9)'], timeoutMs: 10000 },
      deadline: { executable: native, args: ['-e', tree, marker], timeoutMs: 6000 },
      cancel: { executable: native, args: ['-e', tree, marker], timeoutMs: 30000 }
    };
    const projects = [{ projectId:'fixture', root, permissions:{read:true,test:true,hostExecution:true}, commands:{test:profiles} }];
    const executor = new TaskExecutor({ projects, windowsJobRunnerPath:host });
    const task = runnerId => ({ capability:'local:run_tests', payload:{projectId:'fixture',runnerId} });
    const run = (id, signal) => executor.executeTask(task(id), () => {}, signal);
    const result = await run('good');
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['with space', 'quote"and\\', '']);
    assert.match((await run('wrapper')).stdout,/contained-wrapper-ok/);
    await assert.rejects(() => run('fail'), /Process failed/);
    const deadline = run('deadline');
    // Attach the rejection expectation immediately; do not leave unhandled promise.
    const deadlineCheck = assert.rejects(deadline,/LOCAL_PROCESS_TIMEOUT/);
    const timed = await waitMarker(marker);
    await deadlineCheck;
    assert.ok(dead(timed.parent) && dead(timed.child), 'Deadline must drain parent and child');
    fs.rmSync(marker);
    const abort = new AbortController();
    const cancelled = run('cancel', abort.signal);
    const cancelCheck = assert.rejects(cancelled,/LOCAL_PROCESS_CANCELLED/);
    const pids = await waitMarker(marker);
    abort.abort();
    await cancelCheck;
    assert.ok(dead(pids.parent) && dead(pids.child), 'Cancel must drain parent and child');
    assert.equal(executor.isHostExecutionBlocked(), false);
    assert.equal((await run('good')).exitCode, 0);
    const blocked = new TaskExecutor({ projects, windowsJobRunnerPath:host, hostExecutionBlocked:true });
    await assert.rejects(() => blocked.executeTask(task('good'), () => {}), /LOCAL_EXECUTION_RUNTIME_BLOCKED/);
    console.log('Native runner integration PASS',process.arch);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
