import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';
import { GatewayServer } from '../../src/gateway/server';

const VNEXT_ROOT = path.resolve(__dirname, '../..');
const DAEMON_SCRIPT = path.join(VNEXT_ROOT, 'scripts', 'windows', 'agent-daemon.js');
const IPC_CONTROL_SCRIPT = path.join(VNEXT_ROOT, 'scripts', 'windows', 'ipc-control.js');
const IS_WINDOWS = process.platform === 'win32';
const STARTUP_TIMEOUT = IS_WINDOWS ? 60000 : 12000;
const IPC_PROCESS_TIMEOUT = IS_WINDOWS ? 60000 : 12000;
const CLEANUP_TIMEOUT = IS_WINDOWS ? 45000 : 20000;
function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function invokeIpc(dirs: ReturnType<typeof createIsolatedDirs>, deviceId: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath,
      [IPC_CONTROL_SCRIPT, 'shutdown', '--device-id', deviceId, '--timeout-ms', String(timeoutMs), '--json'],
      { env: buildTestEnv(dirs), encoding: 'utf8', timeout: IPC_PROCESS_TIMEOUT, windowsHide: true },
      (err, stdout) => {
        // Unclean shutdown may have a non-zero status. Preserve the structured result.
        try {
          if (!stdout.trim()) throw err || new Error('Missing IPC response');
          resolve(JSON.parse(stdout.trim()));
        } catch (parseError) { reject(parseError); }
      }
    );
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

function createIsolatedDirs(prefix: string) {
  // Standard Windows Temp can inherit AppContainer FullControl ACEs. Do not
  // weaken production parent checks to make fixtures pass. Create a new
  // protected, randomly named test root under the real user profile instead.
  const root = IS_WINDOWS
    ? path.join(os.homedir(), prefix + crypto.randomBytes(12).toString('hex'))
    : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (IS_WINDOWS) {
    const { assertPrivateDirectory } = require(path.join(VNEXT_ROOT, 'scripts', 'windows', 'ipc-security.js'));
    assertPrivateDirectory(root, true);
  }
  const releaseDir = VNEXT_ROOT;
  const configDir = path.join(root, 'config');
  const logDir = path.join(root, 'logs');
  const homeDir = path.join(root, 'home');
  const lockDir = path.join(homeDir, '.devspace-ultra', 'agent-locks');
  const controlDir = path.join(homeDir, '.devspace-ultra', 'agent-control');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(lockDir, { recursive: true });
  // The daemon creates and verifies the private control directory itself.
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { root, releaseDir, configDir, logDir, homeDir, lockDir, controlDir, workspaceDir };
}

function buildTestEnv(dirs: ReturnType<typeof createIsolatedDirs>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USERPROFILE: dirs.homeDir,
    HOME: dirs.homeDir,
    DEVSPACE_RELEASE_DIR: dirs.releaseDir,
    DEVSPACE_CONFIG_DIR: dirs.configDir,
    DEVSPACE_LOG_DIR: dirs.logDir,
    DEVSPACE_AGENT_LOCK_DIR: dirs.lockDir,
    DEVSPACE_AGENT_CONTROL_DIR: dirs.controlDir,
    ...extra
  };
}

function lockPathFor(lockDir: string, deviceId: string): string {
  const hash = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');
  return path.join(lockDir, `${hash}.lock`);
}

function controlPathFor(controlDir: string, deviceId: string): string {
  const hash = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');
  return path.join(controlDir, `${hash}.control.json`);
}

async function stopDaemonGracefully(dirs: ReturnType<typeof createIsolatedDirs>, daemon: ChildProcess, deviceId: string): Promise<any> {
  if (childExited(daemon)) return { alreadyExited: true, code: daemon.exitCode };
  const result = await invokeIpc(dirs, deviceId, 4000);
  await waitFor(() => childExited(daemon), IS_WINDOWS ? 20000 : 5000);
  return result;
}

// Cleanup is limited to this test's own spawned handles and unique directories.
// PID records are used only to wait, never to terminate an arbitrary process.
function recordedWorkerPids(dirs: ReturnType<typeof createIsolatedDirs>): number[] {
  const pids = new Set<number>();
  function readPid(file: string, key: string) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.nonce === 'existing-sentinel') return;
      const pid = value[key];
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    } catch {}
  }
  for (const [dir, suffix, key] of [[dirs.lockDir, '.lock', 'pid'], [dirs.controlDir, '.control.json', 'agentPid']]) {
    try {
      for (const name of fs.readdirSync(dir)) if (name.endsWith(suffix)) readPid(path.join(dir, name), key);
    } catch {}
  }
  readPid(path.join(dirs.workspaceDir, 'slow-child.json'), 'pid');
  return [...pids];
}
function pidStillAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code !== 'ESRCH'; }
}
async function cleanupIsolatedDirs(dirs: ReturnType<typeof createIsolatedDirs>, spawned: ChildProcess[]): Promise<boolean> {
  try {
    const workers = new Set(recordedWorkerPids(dirs));
    for (const daemon of spawned) {
      if (childExited(daemon)) continue;
      // Only the exact ChildProcess object created in this isolated test.
      try { daemon.kill('SIGTERM'); } catch {}
    }
    for (const daemon of spawned) {
      if (childExited(daemon)) continue;
      try { await waitFor(() => childExited(daemon), IS_WINDOWS ? 15000 : 5000); }
      catch {
        if (!childExited(daemon)) { try { daemon.kill('SIGKILL'); } catch {} }
        await waitFor(() => childExited(daemon), 10000);
      }
    }
    for (const pid of recordedWorkerPids(dirs)) workers.add(pid);
    await waitFor(() => [...workers].every(pid => !pidStillAlive(pid)), CLEANUP_TIMEOUT);
    await fs.promises.rm(dirs.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return true;
  } catch (err) {
    console.error('Isolated service fixture cleanup not verified; preserving remaining evidence:', dirs.root, err);
    return false;
  }
}

function sendRawIpc(endpoint: string, payload: string): Promise<any> {
  if (process.platform === 'win32') {
    const { sendMailboxRequest } = require(path.join(VNEXT_ROOT, 'scripts', 'windows', 'ipc-security.js'));
    return sendMailboxRequest(endpoint, JSON.parse(payload), 5000);
  }
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on('error', reject);
  });
}

export async function runWindowsServiceDaemonIntegrationTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  // Test 1: Normal startup, custom AGENT_NAME vs default, duplicate rejection, IPC auth boundary, and clean IPC shutdown + lock release
  {
    const dirs = createIsolatedDirs('dsu-svc-test1-');
    const storageDir = path.join(dirs.root, 'gw-storage');
    const port = 27500 + Math.floor(Math.random() * 1000);
    const server = new GatewayServer({ port, host: '127.0.0.1', storageDir, masterSecret: 'svc-test-master-secret-32-chars-min!' });
    const spawned: ChildProcess[] = [];

    try {
      await server.start();
      const reg1 = server.authManager.registerDevice('Primary', 'windows', ['local:read', 'local:write'], 'svc-dev-1');
      const reg2 = server.authManager.registerDevice('Secondary', 'windows', ['local:read'], 'svc-dev-2');

      fs.writeFileSync(
        path.join(dirs.configDir, 'projects.json'),
        JSON.stringify({
          projects: [
            { projectId: 'demo', displayName: 'Demo', root: dirs.workspaceDir, permissions: { read: true, write: false, test: false, build: false, hostExecution: false } }
          ]
        })
      );
      fs.writeFileSync(
        path.join(dirs.configDir, '.env'),
        [
          `GATEWAY_URL=ws://127.0.0.1:${port}/ws/agent`,
          `AGENT_ID=${reg1.deviceId}`,
          `AGENT_NAME=Workstation-Custom-1`,
          `AGENT_TOKEN=${reg1.token}`,
          `LOCAL_PROJECTS_CONFIG=projects.json`,
          `ALLOW_RAW_SHELL=false`,
          `ADMIN_SECRET=should-never-enter-agent`,
          `MASTER_SECRET=should-never-enter-agent`,
          `CLIENT_TOKEN=dsu_client_should_never_enter`
        ].join('\n')
      );

      const daemon1 = spawn(process.execPath, [DAEMON_SCRIPT], {
        env: buildTestEnv(dirs),
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(daemon1);

      const lp1 = lockPathFor(dirs.lockDir, reg1.deviceId);
      const cp1 = controlPathFor(dirs.controlDir, reg1.deviceId);

      await waitFor(() => server.connectionManager.getConnectedAgents().length === 1 && fs.existsSync(lp1) && fs.existsSync(cp1), STARTUP_TIMEOUT);

      const connected1 = server.connectionManager.getConnectedAgents()[0];
      assert.strictEqual(connected1.deviceId, 'svc-dev-1');
      assert.strictEqual(connected1.name, 'Workstation-Custom-1');
      assert.ok(!connected1.capabilities.includes('local:run_tests'));
      assert.ok(!connected1.capabilities.includes('local:build_project'));
      assert.ok(!connected1.capabilities.includes('local:raw_shell'));

      const lockJson = JSON.parse(fs.readFileSync(lp1, 'utf8'));
      const ctrlJson = JSON.parse(fs.readFileSync(cp1, 'utf8'));
      assert.strictEqual(lockJson.pid, ctrlJson.agentPid);

      // Verify unauthorized IPC token & arbitrary action rejection
      const badTokenResp = await sendRawIpc(ctrlJson.ipcEndpoint, JSON.stringify({ action: 'SHUTDOWN', token: 'wrong-token', deviceId: reg1.deviceId }) + '\n');
      assert.strictEqual(badTokenResp.ok, false);
      assert.strictEqual(badTokenResp.error, 'UNAUTHORIZED');

      const badActionResp = await sendRawIpc(ctrlJson.ipcEndpoint, JSON.stringify({ action: 'EXEC_SHELL', token: ctrlJson.ipcSecret, deviceId: reg1.deviceId }) + '\n');
      assert.strictEqual(badActionResp.ok, false);
      assert.strictEqual(badActionResp.error, 'FORBIDDEN_ACTION');
      const wrongDevice = await sendRawIpc(ctrlJson.ipcEndpoint, JSON.stringify({ action: 'SHUTDOWN', token: ctrlJson.ipcSecret, deviceId: 'wrong-device' }) + '\n');
      assert.strictEqual(wrongDevice.error, 'DEVICE_MISMATCH');
      assert.strictEqual(server.connectionManager.getConnectedAgents().length, 1);

      // Duplicate daemon start must fail-closed cleanly without disturbing live agent
      const dupDaemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        env: buildTestEnv(dirs),
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(dupDaemon);
      await waitFor(() => childExited(dupDaemon), IS_WINDOWS ? 30000 : 6000);
      assert.strictEqual(dupDaemon.exitCode, 0);
      assert.strictEqual(server.connectionManager.getConnectedAgents().length, 1);
      assert.ok(fs.existsSync(lp1));

      // Verify daemon log never leaked tokens or secrets
      const logContent = fs.readFileSync(path.join(dirs.logDir, 'agent-daemon.log'), 'utf8');
      assert.ok(!logContent.includes(reg1.token));
      assert.ok(!logContent.includes('should-never-enter-agent'));
      assert.ok(logContent.includes('Stripped unnecessary sensitive env keys'));

      // Graceful IPC shutdown drains cleanly and releases lock
      const stopResult = await stopDaemonGracefully(dirs, daemon1, reg1.deviceId);
      assert.strictEqual(stopResult.ok, true);
      assert.strictEqual(stopResult.clean, true);
      assert.strictEqual(stopResult.lockRetained, false);
      assert.strictEqual(fs.existsSync(lp1), false);
      assert.strictEqual(fs.existsSync(cp1), false);

      // Start second agent with another distinct AGENT_NAME in isolated configDir
      const dirs2 = createIsolatedDirs('dsu-svc-test1b-');
      const spawned2: ChildProcess[] = [];
      try {
        fs.writeFileSync(
          path.join(dirs2.configDir, '.env'),
          [
            `GATEWAY_URL=ws://127.0.0.1:${port}/ws/agent`,
            `AGENT_ID=${reg2.deviceId}`,
            `AGENT_NAME=Workstation-Custom-2`,
            `AGENT_TOKEN=${reg2.token}`
          ].join('\n')
        );
        const daemon2 = spawn(process.execPath, [DAEMON_SCRIPT], {
          env: buildTestEnv(dirs2),
          stdio: 'ignore',
          windowsHide: true
        });
        spawned2.push(daemon2);
        await waitFor(() => server.connectionManager.getConnectedAgents().some(a => a.deviceId === 'svc-dev-2'), STARTUP_TIMEOUT);
        const connected2 = server.connectionManager.getConnectedAgents().find(a => a.deviceId === 'svc-dev-2');
        assert.strictEqual(connected2?.name, 'Workstation-Custom-2');
        await stopDaemonGracefully(dirs2, daemon2, reg2.deviceId);
      } finally {
        if (!(await cleanupIsolatedDirs(dirs2, spawned2))) failed++;
      }

      passed++;
    } catch (err) {
      console.error('Integration Test 1 (startup/IPC/duplicate/AGENT_NAME) failed:', err);
      failed++;
    } finally {
      // Terminate only sockets from this test's private gateway before closing HTTP.
      // Otherwise a timed-out startup can leave an upgraded WebSocket holding shutdown.
      for (const conn of server.connectionManager.getConnectedAgents()) {
        try { conn.socket.terminate(); } catch {}
      }
      await server.stop().catch(() => {});
      if (!(await cleanupIsolatedDirs(dirs, spawned))) failed++;
    }
  }

  // Test 2: Lock conflict (existing lock -> exits fail-closed, does NOT restart, does NOT delete lock)
  {
    const dirs = createIsolatedDirs('dsu-svc-test2-');
    const spawned: ChildProcess[] = [];
    try {
      const deviceId = 'lock-conflict-dev';
      const lp = lockPathFor(dirs.lockDir, deviceId);
      const sentinel = JSON.stringify({ pid: 999999, deviceId, startedAt: Date.now(), nonce: 'existing-sentinel' });
      fs.writeFileSync(lp, sentinel);
      fs.writeFileSync(
        path.join(dirs.configDir, '.env'),
        `GATEWAY_URL=ws://127.0.0.1:1/ws/agent\nAGENT_ID=${deviceId}\nAGENT_TOKEN=dsu_device_placeholder.sig\n`
      );

      const daemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        env: buildTestEnv(dirs),
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(daemon);

      await waitFor(() => childExited(daemon), STARTUP_TIMEOUT);
      assert.strictEqual(daemon.exitCode, 0, 'Daemon must exit 0 so Task Scheduler does not restart on fail-closed lock conflict');
      assert.strictEqual(fs.readFileSync(lp, 'utf8'), sentinel, 'Existing lock must remain untouched');
      const logContent = fs.readFileSync(path.join(dirs.logDir, 'agent-daemon.log'), 'utf8');
      assert.ok(logContent.includes('LOCK_CONFLICT') && logContent.includes('FAIL_CLOSED'));
      passed++;
    } catch (err) {
      console.error('Integration Test 2 (lock conflict fail-closed) failed:', err);
      failed++;
    } finally {
      if (!(await cleanupIsolatedDirs(dirs, spawned))) failed++;
    }
  }

  // Test 3: Policy rejection (revoked device -> exits fail-closed without auto-restart)
  {
    const dirs = createIsolatedDirs('dsu-svc-test3-');
    const storageDir = path.join(dirs.root, 'gw-storage');
    const port = 28500 + Math.floor(Math.random() * 1000);
    const server = new GatewayServer({ port, host: '127.0.0.1', storageDir, masterSecret: 'svc-test-master-secret-32-chars-min!' });
    const spawned: ChildProcess[] = [];

    try {
      await server.start();
      const reg = server.authManager.registerDevice('Revoked Test', 'windows', ['local:read'], 'revoked-dev');
      server.authManager.revokeDevice(reg.deviceId, 'Test policy revocation');

      fs.writeFileSync(
        path.join(dirs.configDir, '.env'),
        `GATEWAY_URL=ws://127.0.0.1:${port}/ws/agent\nAGENT_ID=${reg.deviceId}\nAGENT_TOKEN=${reg.token}\n`
      );

      const daemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        env: buildTestEnv(dirs),
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(daemon);

      await waitFor(() => childExited(daemon), STARTUP_TIMEOUT);
      assert.strictEqual(daemon.exitCode, 0, 'Daemon must exit 0 on policy rejection so Task Scheduler does not loop');
      const logContent = fs.readFileSync(path.join(dirs.logDir, 'agent-daemon.log'), 'utf8');
      assert.ok(logContent.includes('POLICY_REJECTED') && logContent.includes('FAIL_CLOSED'));
      assert.strictEqual(fs.existsSync(lockPathFor(dirs.lockDir, reg.deviceId)), false);
      passed++;
    } catch (err) {
      console.error('Integration Test 3 (policy rejection fail-closed) failed:', err);
      failed++;
    } finally {
      // Terminate only sockets from this test's private gateway before closing HTTP.
      // Otherwise a timed-out startup can leave an upgraded WebSocket holding shutdown.
      for (const conn of server.connectionManager.getConnectedAgents()) {
        try { conn.socket.terminate(); } catch {}
      }
      await server.stop().catch(() => {});
      if (!(await cleanupIsolatedDirs(dirs, spawned))) failed++;
    }
  }

  // Test 4: Network outage & reconnect inside worker without daemon restart or losing lock
  {
    const dirs = createIsolatedDirs('dsu-svc-test4-');
    const storageDir = path.join(dirs.root, 'gw-storage');
    const port = 29500 + Math.floor(Math.random() * 1000);
    let server = new GatewayServer({ port, host: '127.0.0.1', storageDir, masterSecret: 'svc-test-master-secret-32-chars-min!' });
    const spawned: ChildProcess[] = [];

    try {
      await server.start();
      const reg = server.authManager.registerDevice('Reconnect Test', 'windows', ['local:read'], 'reconn-dev');
      fs.writeFileSync(
        path.join(dirs.configDir, '.env'),
        `GATEWAY_URL=ws://127.0.0.1:${port}/ws/agent\nAGENT_ID=${reg.deviceId}\nAGENT_TOKEN=${reg.token}\n`
      );

      const daemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        env: buildTestEnv(dirs),
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(daemon);

      const cp = controlPathFor(dirs.controlDir, reg.deviceId);
      await waitFor(() => server.connectionManager.getConnectedAgents().length === 1 && fs.existsSync(cp), STARTUP_TIMEOUT);
      const originalAgentPid = JSON.parse(fs.readFileSync(cp, 'utf8')).agentPid;

      // Drop gateway -> wait -> bring gateway back on same port (simulate sudden network drop)
      for (const conn of server.connectionManager.getConnectedAgents()) {
        try { conn.socket.terminate(); } catch {}
      }
      await server.stop();
      await new Promise(r => setTimeout(r, 400));

      server = new GatewayServer({ port, host: '127.0.0.1', storageDir, masterSecret: 'svc-test-master-secret-32-chars-min!' });
      await server.start();

      await waitFor(() => server.connectionManager.getConnectedAgents().length === 1, STARTUP_TIMEOUT);
      const afterAgentPid = JSON.parse(fs.readFileSync(cp, 'utf8')).agentPid;
      assert.strictEqual(afterAgentPid, originalAgentPid, 'Worker PID must remain identical across transient WS reconnect');

      const stopRes = await stopDaemonGracefully(dirs, daemon, reg.deviceId);
      assert.strictEqual(stopRes.clean, true);
      passed++;
    } catch (err) {
      console.error('Integration Test 4 (network disconnect & reconnect) failed:', err);
      failed++;
    } finally {
      // Terminate only sockets from this test's private gateway before closing HTTP.
      // Otherwise a timed-out startup can leave an upgraded WebSocket holding shutdown.
      for (const conn of server.connectionManager.getConnectedAgents()) {
        try { conn.socket.terminate(); } catch {}
      }
      await server.stop().catch(() => {});
      if (!(await cleanupIsolatedDirs(dirs, spawned))) failed++;
    }
  }

  // Test 5: Log rotation (maxLogBytes=600, maxLogFiles=5) & bounded crash circuit breaker
  {
    const dirs = createIsolatedDirs('dsu-svc-test5-');
    const spawned: ChildProcess[] = [];
    try {
      // Point releaseDir to an isolated fake dist entry that crashes with exit code 1
      const fakeRelease = path.join(dirs.root, 'fake-release');
      const helperSrc = path.join(VNEXT_ROOT, 'dist', 'local-agent', 'service-exit-codes.js');
      fs.mkdirSync(path.join(fakeRelease, 'dist', 'local-agent'), { recursive: true });
      fs.mkdirSync(path.join(fakeRelease, 'dist', 'cli'), { recursive: true });
      fs.copyFileSync(helperSrc, path.join(fakeRelease, 'dist', 'local-agent', 'service-exit-codes.js'));
      fs.writeFileSync(
        path.join(fakeRelease, 'dist', 'cli', 'agent-cli.js'),
        `console.log('Simulated transient crash token=dsu_device_secret123.xyz'); process.exit(1);\n`
      );
      fs.writeFileSync(
        path.join(dirs.configDir, '.env'),
        `GATEWAY_URL=ws://127.0.0.1:1/ws/agent\nAGENT_ID=crash-test-dev\nAGENT_TOKEN=dsu_device_placeholder.sig\n`
      );

      // Override releaseDir & shrink log limit + maxRapidRestarts=2 so test runs quickly (~4.5s)
      const env = buildTestEnv(dirs, {
        DEVSPACE_RELEASE_DIR: fakeRelease,
        DEVSPACE_LOG_MAX_BYTES: '1024',
        DEVSPACE_LOG_MAX_FILES: '5',
        DEVSPACE_MAX_RAPID_RESTARTS: '2'
      });

      const daemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        env,
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(daemon);

      await waitFor(() => childExited(daemon), STARTUP_TIMEOUT);
      assert.strictEqual(daemon.exitCode, 0, 'Circuit breaker must stop daemon cleanly without infinite loop');

      const logFiles = fs.readdirSync(dirs.logDir).filter(f => f.startsWith('agent-daemon.log'));
      assert.ok(logFiles.includes('agent-daemon.log'));
      assert.ok(logFiles.some(f => f === 'agent-daemon.log.1'), `Expected rotated log .1, got: ${logFiles.join(', ')}`);
      assert.ok(logFiles.length <= 6, 'Rotated logs must remain bounded');

      const combinedLogs = logFiles.map(f => fs.readFileSync(path.join(dirs.logDir, f), 'utf8')).join('\n');
      assert.ok(combinedLogs.includes('CIRCUIT_BREAKER'));
      assert.ok(!combinedLogs.includes('dsu_device_secret123'));
      passed++;
    } catch (err) {
      console.error('Integration Test 5 (log rotation & circuit breaker) failed:', err);
      failed++;
    } finally {
      if (!(await cleanupIsolatedDirs(dirs, spawned))) failed++;
    }
  }

  // Test 6: Shutdown timeout with in-flight mutating task preserves lock, exits 13, and never marks unfinished mutation succeeded
  {
    const dirs = createIsolatedDirs('dsu-svc-test6-');
    const storageDir = path.join(dirs.root, 'gw-storage');
    const port = 30500 + Math.floor(Math.random() * 1000);
    const server = new GatewayServer({ port, host: '127.0.0.1', storageDir, masterSecret: 'svc-test-master-secret-32-chars-min!' });
    const spawned: ChildProcess[] = [];

    try {
      await server.start();
      const reg = server.authManager.registerDevice('Slow Mutation Test', 'windows', ['local:read', 'local:exec'], 'slow-mut-dev');

      fs.writeFileSync(
        path.join(dirs.configDir, 'projects.json'),
        JSON.stringify({
          projects: [
            {
              projectId: 'slow-proj',
              displayName: 'Slow Proj',
              root: dirs.workspaceDir,
              permissions: { read: true, write: false, test: false, build: true, hostExecution: true },
              commands: {
                build: {
                  slow: { executable: process.execPath, args: ['-e',
                    'require("fs").writeFileSync("slow-child.json", JSON.stringify({pid:process.pid})); setTimeout(() => console.log("late"), ' +
                    (IS_WINDOWS ? 30000 : 8000) + ')'] }
                }
              }
            }
          ]
        })
      );
      fs.writeFileSync(
        path.join(dirs.configDir, '.env'),
        [
          `GATEWAY_URL=ws://127.0.0.1:${port}/ws/agent`,
          `AGENT_ID=${reg.deviceId}`,
          `AGENT_TOKEN=${reg.token}`,
          `LOCAL_PROJECTS_CONFIG=projects.json`
        ].join('\n')
      );

      const daemon = spawn(process.execPath, [DAEMON_SCRIPT], {
        env: buildTestEnv(dirs),
        stdio: 'ignore',
        windowsHide: true
      });
      spawned.push(daemon);

      const lp = lockPathFor(dirs.lockDir, reg.deviceId);
      const cp = controlPathFor(dirs.controlDir, reg.deviceId);
      await waitFor(() => server.connectionManager.getConnectedAgents().length === 1 && fs.existsSync(lp) && fs.existsSync(cp), STARTUP_TIMEOUT);

      const submitRes = await server.taskRouter.routeTaskSubmit(
        {
          backend: 'local',
          capability: 'local:build_project',
          targetDeviceId: reg.deviceId,
          payload: { projectId: 'slow-proj', commandId: 'slow' }
        },
        ['admin'],
        'test-client'
      );

      await waitFor(() => {
        const t = server.taskStore.getTask(submitRes.taskId);
        return t?.status === 'running' && fs.existsSync(path.join(dirs.workspaceDir, 'slow-child.json'));
      }, STARTUP_TIMEOUT);

      const stopResult = await invokeIpc(dirs, reg.deviceId, 600);
      await waitFor(() => childExited(daemon), IS_WINDOWS ? 20000 : 6000);
      assert.strictEqual(stopResult.ok, true);
      assert.strictEqual(stopResult.clean, false);
      assert.strictEqual(stopResult.exitCode, 13);
      assert.strictEqual(stopResult.lockRetained, true);
      assert.strictEqual(fs.existsSync(lp), true, 'Lock must remain intact when mutation times out during shutdown');

      const taskAfter = server.taskStore.getTask(submitRes.taskId);
      assert.notStrictEqual(taskAfter?.status, 'succeeded', 'Unfinished mutation must never be marked succeeded');
      passed++;
    } catch (err) {
      console.error('Integration Test 6 (shutdown timeout with in-flight mutation) failed:', err);
      failed++;
    } finally {
      // Terminate only sockets from this test's private gateway before closing HTTP.
      // Otherwise a timed-out startup can leave an upgraded WebSocket holding shutdown.
      for (const conn of server.connectionManager.getConnectedAgents()) {
        try { conn.socket.terminate(); } catch {}
      }
      await server.stop().catch(() => {});
      if (!(await cleanupIsolatedDirs(dirs, spawned))) failed++;
    }
  }

  // Test 7: An existing unverified control directory must fail closed before worker launch.
  {
    const dirs = createIsolatedDirs('dsu-svc-unsafe-acl-');
    let daemon: ChildProcess | undefined;
    try {
      // On Windows this deliberately has an inherited, unprotected DACL.
      // On POSIX use an explicitly group/world-accessible directory.
      fs.mkdirSync(dirs.controlDir, { recursive: true });
      if (process.platform !== 'win32') fs.chmodSync(dirs.controlDir, 0o777);
      const deviceId = 'unsafe-acl-test-device';
      fs.writeFileSync(path.join(dirs.configDir, '.env'),
        'GATEWAY_URL=ws://127.0.0.1:1/ws/agent\nAGENT_ID=' + deviceId + '\nAGENT_TOKEN=dsu_device_placeholder.sig\n');
      daemon = spawn(process.execPath, [DAEMON_SCRIPT], { env: buildTestEnv(dirs), stdio: 'ignore', windowsHide: true });
      await waitFor(() => childExited(daemon!), STARTUP_TIMEOUT);
      assert.strictEqual(daemon.exitCode, 0);
      const log = fs.readFileSync(path.join(dirs.logDir, 'agent-daemon.log'), 'utf8');
      assert.ok(log.includes('IPC_ACL_INVALID'));
      assert.ok(!log.includes('Agent worker started'));
      assert.strictEqual(fs.existsSync(controlPathFor(dirs.controlDir, deviceId)), false);
      assert.strictEqual(fs.existsSync(lockPathFor(dirs.lockDir, deviceId)), false);
      passed++;
    } catch (err) {
      console.error('Integration Test 7 (unsafe IPC control directory) failed:', err);
      failed++;
    } finally {
      if (!(await cleanupIsolatedDirs(dirs, daemon ? [daemon] : []))) failed++;
    }
  }

  return { passed, failed };
}
