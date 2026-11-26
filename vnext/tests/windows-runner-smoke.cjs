// Standalone compiled-runtime smoke; requires Windows, no production credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskExecutor } = require('../dist/local-agent/task-executor');
async function main() {
  assert.equal(process.platform, 'win32');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsu~runner smoke '));
  try {
    const root = path.join(tmp, 'project');
    fs.mkdirSync(root);
    const native = process.execPath;
    const wrapper = path.join(tmp, 'fixture wrapper.cmd');
    fs.writeFileSync(wrapper, '@echo off\r\nif not "%~1"=="test argument" exit /b 19\r\nif defined AGENT_TOKEN exit /b 20\r\necho wrapper-ok\r\nexit /b 0\r\n');
    const executor = new TaskExecutor({ projects: [{
      projectId: 'fixture', root,
      permissions: { read: true, test: true, hostExecution: true },
      commands: { test: {
        wrapper: { executable: wrapper, args: ['test argument'] },
        native: { executable: native, args: ['-e', 'console.log("native-ok")'] },
        unsafe: { executable: wrapper, args: ['x&echo injected'] }
      }}
    }] });
    const make = runnerId => ({ capability: 'local:run_tests', payload: { projectId: 'fixture', runnerId } });
    const previous = process.env.AGENT_TOKEN;
    process.env.AGENT_TOKEN = 'synthetic-fixture-only';
    try {
      // Diagnostics contain only synthetic fixture path information, never environment values.
      const wrapperReal = fs.realpathSync(wrapper);
      console.log('Wrapper path diagnostic:', JSON.stringify({
        path: wrapperReal,
        unsafeCharacters: [...new Set(wrapperReal.slice(3).replace(/[A-Za-z0-9_ .()~\\/-]/g, ''))]
      }));
      assert.match((await executor.executeTask(make('wrapper'), () => {})).stdout, /wrapper-ok/);
      assert.match((await executor.executeTask(make('native'), () => {})).stdout, /native-ok/);
      await assert.rejects(() => executor.executeTask(make('unsafe'), () => {}), /LOCAL_RUNNER_WRAPPER_ARGUMENT_DENIED/);
      await assert.rejects(() => executor.executeTask(make('npm'), () => {}), /LOCAL_RUNNER_NOT_ALLOWED/);
      for (const unsafe of ['%PATH%', '!X!', 'a|b', 'a>b', 'a<b', 'a^b', 'a"b', 'a\nb']) {
        await assert.rejects(async () => executor.executeProcessWithoutShell(wrapper, [unsafe], root, undefined, () => {}), /LOCAL_RUNNER_WRAPPER_ARGUMENT_DENIED/);
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_TOKEN;
      else process.env.AGENT_TOKEN = previous;
    }
    console.log('Windows runner smoke PASS', process.arch);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
