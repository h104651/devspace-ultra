const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const { resolveConfiguration, loadDotEnvFile } = require('./service-config');
const { assertPrivateDirectory, assertPrivateFile, atomicJson, readBoundedJson, mailboxPath } = require('./ipc-security');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function constantTimeTokenMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function loadSharedExitHelpers(releaseDir) {
  const helperPath = path.join(releaseDir, 'dist', 'local-agent', 'service-exit-codes.js');
  if (!fs.existsSync(helperPath)) {
    throw new Error(`Compiled service helper missing at '${helperPath}'. Run 'npm run build' in '${releaseDir}'.`);
  }
  return require(helperPath);
}

function createLogWriter(logDir, maxLogBytes, maxLogFiles, redactFn) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'agent-daemon.log');

  function rotateIfNeeded(nextBytes) {
    try {
      if (!fs.existsSync(logFile)) return;
      const st = fs.statSync(logFile);
      if (st.size + nextBytes < maxLogBytes) return;

      const oldest = `${logFile}.${maxLogFiles}`;
      if (fs.existsSync(oldest)) {
        fs.unlinkSync(oldest);
      }
      for (let i = maxLogFiles - 1; i >= 1; i--) {
        const src = `${logFile}.${i}`;
        const dst = `${logFile}.${i + 1}`;
        if (fs.existsSync(src)) {
          fs.renameSync(src, dst);
        }
      }
      fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      // Do not crash daemon due to rotation error
    }
  }

  function appendRaw(text) {
    const clean = redactFn(text);
    rotateIfNeeded(Buffer.byteLength(clean, 'utf8'));
    fs.appendFileSync(logFile, clean, 'utf8');
  }

  function log(msg) {
    const timestamp = new Date().toISOString();
    appendRaw(`[${timestamp}] ${msg}\n`);
  }

  return { logFile, log, appendRaw };
}

function buildIpcEndpoint(controlDir, deviceId) {
  const userName = (process.env.USERNAME || process.env.USER || os.userInfo().username || 'user').toLowerCase();
  const userHash = crypto.createHash('sha256').update(userName).digest('hex').slice(0, 12);
  const deviceHash = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');

  if (process.platform === 'win32') {
    return {
      deviceHash,
      endpoint: `\\\\.\\pipe\\devspace-ultra-daemon-${userHash}-${deviceHash.slice(0, 16)}`
    };
  }
  return {
    deviceHash,
    endpoint: path.join(controlDir, `${userHash}-${deviceHash.slice(0, 16)}.sock`)
  };
}

function main() {
  const cfg = resolveConfiguration();
  const helpers = loadSharedExitHelpers(cfg.releaseDir);
  const {
    AGENT_EXIT_CODES,
    NON_RETRYABLE_EXIT_CODES,
    classifyAgentExitCode,
    buildSanitizedAgentEnv,
    redactSensitiveLogLine
  } = helpers;

  const logger = createLogWriter(cfg.logDir, cfg.maxLogBytes, cfg.maxLogFiles, redactSensitiveLogLine);
  const fileEnv = loadDotEnvFile(cfg.envPath, cfg.releaseDir);
  const sanitized = buildSanitizedAgentEnv(process.env, fileEnv);
  const childEnv = {
    ...sanitized.env,
    DEVSPACE_RELEASE_DIR: cfg.releaseDir,
    DEVSPACE_CONFIG_DIR: cfg.configDir,
    DEVSPACE_ENV_FILE: cfg.envPath,
    DEVSPACE_LOG_DIR: cfg.logDir,
    DEVSPACE_SHUTDOWN_TIMEOUT_MS: String(cfg.shutdownTimeoutMs)
  };

  const deviceId = (childEnv.AGENT_ID || '').trim();
  const agentName = (childEnv.AGENT_NAME || '').trim();
  const lockDir = childEnv.DEVSPACE_AGENT_LOCK_DIR
    ? path.resolve(childEnv.DEVSPACE_AGENT_LOCK_DIR)
    : path.join(os.homedir(), '.devspace-ultra', 'agent-locks');
  const controlDir = process.env.DEVSPACE_AGENT_CONTROL_DIR
    ? path.resolve(process.env.DEVSPACE_AGENT_CONTROL_DIR)
    : path.join(os.homedir(), '.devspace-ultra', 'agent-control');

  try { assertPrivateDirectory(controlDir, true); } catch {
    logger.log('[DAEMON][FAIL_CLOSED] IPC_ACL_INVALID: private control directory not verified.');
    process.exit(0);
  }

  logger.log('=== DevSpace Ultra Local Agent Daemon Starting ===');
  logger.log(`Release Directory  : ${cfg.releaseDir}`);
  logger.log(`Config Directory   : ${cfg.configDir}`);
  logger.log(`Log Directory      : ${cfg.logDir}`);
  logger.log(`Device ID          : ${deviceId || '<MISSING>'}`);
  logger.log(`Device Name        : ${agentName || `Local-Agent-${os.hostname()} (default)`}`);
  if (sanitized.strippedSensitiveKeys.length > 0) {
    logger.log(`[SECURITY] Stripped unnecessary sensitive env keys from agent env: ${sanitized.strippedSensitiveKeys.join(', ')}`);
  }

  if (!deviceId || !childEnv.AGENT_TOKEN) {
    logger.log(`[DAEMON][FAIL_CLOSED] Missing AGENT_ID or AGENT_TOKEN in '${cfg.envPath}'. Exiting with 0 to prevent Task Scheduler restart loop.`);
    process.exit(0);
  }

  const entryScript = path.join(cfg.releaseDir, 'dist', 'cli', 'agent-cli.js');
  if (!fs.existsSync(entryScript)) {
    logger.log(`[DAEMON][FAIL_CLOSED] Compiled entry script missing: '${entryScript}'. Exiting with 0.`);
    process.exit(0);
  }

  const { deviceHash, endpoint: socketEndpoint } = buildIpcEndpoint(controlDir, deviceId);
  const instanceId = crypto.randomBytes(16).toString('hex');
  const ipcTransport = process.platform === 'win32' ? 'mailbox' : 'socket';
  const ipcEndpoint = ipcTransport === 'mailbox' ? mailboxPath(controlDir, deviceHash, instanceId) : socketEndpoint;
  const lockPath = path.join(lockDir, `${deviceHash}.lock`);
  const controlPath = path.join(controlDir, `${deviceHash}.control.json`);
  const ownerPath = path.join(controlDir, `${deviceHash}.daemon.lock`);
  const ownerRecord = JSON.stringify({ daemonPid: process.pid, deviceId, instanceId, startedAt: Date.now() });

  // Exclusive publication ownership. Never take over unverifiable stale records.
  try {
    fs.writeFileSync(ownerPath, ownerRecord, { flag: 'wx', mode: 0o600 });
  } catch {
    logger.log('[DAEMON][FAIL_CLOSED] Duplicate or unreconciled daemon owner record. Operator audit required.');
    process.exit(0);
  }
  if (fs.existsSync(controlPath)) {
    logger.log('[DAEMON][FAIL_CLOSED] Unreconciled control record. Operator audit required.');
    // Retain new owner record so repeated attempts cannot bypass the audit.
    process.exit(0);
  }
  if (ipcTransport === 'mailbox') {
    try { assertPrivateDirectory(ipcEndpoint, true); } catch {
      logger.log('[DAEMON][FAIL_CLOSED] IPC_ACL_INVALID: private mailbox not verified; owner retained for audit.');
      process.exit(0);
    }
  }

  const ipcSecret = crypto.randomBytes(32).toString('hex');
  const daemonStartedAt = Date.now();
  let activeChild = null;
  let activeAgentPid = null;
  let isTerminating = false;
  let consecutiveRapidExits = 0;
  let restartTimer = null;
  let lastExitClassification = null;
  let ipcServer = null;
  let ownsIpcEndpoint = false;
  let shutdownPromise = null;
  let mailboxTimer = null;
  let mailboxBusy = false;

  function writeControlFile() {
    const payload = {
      daemonPid: process.pid,
      agentPid: activeAgentPid,
      deviceId,
      user: process.env.USERNAME || process.env.USER || os.userInfo().username,
      ipcEndpoint,
      ipcTransport,
      instanceId,
      ipcSecret,
      releaseDir: cfg.releaseDir,
      configDir: cfg.configDir,
      lockPath,
      startedAt: daemonStartedAt
    };
    if (fs.readFileSync(ownerPath, 'utf8') !== ownerRecord) throw new Error('IPC owner record changed');
    atomicJson(controlPath, payload);
  }

  function removeOwnControlFile() {
    // A second daemon cannot publish or remove another instance's control record.
    try {
      if (fs.readFileSync(ownerPath, 'utf8') !== ownerRecord) return;
      if (fs.existsSync(controlPath)) {
        const cur = readBoundedJson(controlPath, 65536);
        if (cur.daemonPid !== process.pid || cur.instanceId !== instanceId || cur.ipcSecret !== ipcSecret) return;
        fs.unlinkSync(controlPath);
      }
      if (ownsIpcEndpoint && ipcTransport === 'socket' && fs.existsSync(ipcEndpoint)) {
        try { fs.unlinkSync(ipcEndpoint); } catch {}
      }
      fs.unlinkSync(ownerPath);
      // Mailbox responses must remain readable after exit. The shutdown client removes
      // its own response and may remove the empty per-launch directory.
    } catch { /* Preserve unreconciled owner/control state for operator audit. */ }
  }

  function cleanupAndExit(exitCode = 0) {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (mailboxTimer) { clearInterval(mailboxTimer); mailboxTimer = null; }
    removeOwnControlFile();
    if (ipcServer) {
      try { ipcServer.close(); } catch {}
      ipcServer = null;
    }
    process.exit(exitCode);
  }

  function initiateGracefulShutdown(reason, requestedTimeoutMs) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise((resolve) => {
      if (isTerminating && !activeChild) {
        resolve({ ok: true, clean: true, exitCode: AGENT_EXIT_CODES.CLEAN, exitReason: 'ALREADY_STOPPING', lockRetained: fs.existsSync(lockPath) });
        return;
      }
      isTerminating = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }

      const timeoutMs = Math.min(30000, Math.max(500, Number(requestedTimeoutMs) || cfg.shutdownTimeoutMs));
      logger.log(`[DAEMON][STOP] Initiating graceful shutdown (${reason}, timeout=${timeoutMs}ms). Auto-restart disabled.`);

      const child = activeChild;
      if (!child) {
        const lockExists = fs.existsSync(lockPath);
        logger.log(`[DAEMON][STOP] No active worker process. Lock exists=${lockExists}.`);
        resolve({ ok: true, clean: !lockExists, exitCode: AGENT_EXIT_CODES.CLEAN, exitReason: 'NO_ACTIVE_WORKER', lockRetained: lockExists });
        return;
      }

      let finished = false;
      const forceTimer = setTimeout(() => {
        if (finished) return;
        logger.log(`[DAEMON][STOP_TIMEOUT] Worker PID ${child.pid} did not stop within ${timeoutMs + 3000}ms; terminating process and preserving lock for manual audit.`);
        try { child.kill('SIGKILL'); } catch {}
      }, timeoutMs + 3000);

      child.once('close', (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        const exitReason = classifyAgentExitCode(code);
        const lockExists = fs.existsSync(lockPath);
        const clean = code === AGENT_EXIT_CODES.CLEAN && !lockExists;
        logger.log(`[DAEMON][STOP_COMPLETE] Worker PID ${child.pid} exited (code=${code}, signal=${signal}, reason=${exitReason}, lockRetained=${lockExists}).`);
        resolve({
          ok: true,
          clean,
          exitCode: code,
          signal,
          exitReason,
          lockRetained: lockExists
        });
      });

      try {
        if (child.connected) {
          child.send({ type: 'SHUTDOWN', timeoutMs });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
    });
    return shutdownPromise;
  }

  function startAgent() {
    if (isTerminating) return;

    const launchTime = Date.now();
    logger.log(`[DAEMON] Starting agent-cli process (lockPath=${lockPath})...`);
    const child = spawn(process.execPath, [entryScript], {
      cwd: cfg.configDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    });

    activeChild = child;
    activeAgentPid = child.pid;
    logger.log(`[DAEMON] Agent worker started with PID: ${child.pid}`);

    child.stdout.on('data', (d) => {
      logger.appendRaw(d.toString());
    });

    child.stderr.on('data', (d) => {
      const text = d.toString();
      const lines = text.split(/\r?\n/);
      for (const l of lines) {
        if (l.trim()) logger.appendRaw(`[STDERR] ${l}\n`);
      }
    });

    child.on('message', (msg) => {
      if (msg && msg.type === 'AGENT_STARTED') {
        if (msg.pid !== child.pid || msg.deviceId !== deviceId || msg.lockPath !== lockPath) {
          failClosed('WORKER_IDENTITY_MISMATCH');
          return;
        }
        activeAgentPid = child.pid;
        try { writeControlFile(); } catch { failClosed('IPC_CONTROL_PUBLISH_FAILURE'); return; }
        logger.log(`[DAEMON] Lock ownership confirmed for PID ${activeAgentPid} (${msg.lockPath || lockPath}).`);
      }
    });

    child.on('close', (code, signal) => {
      const lifespan = Date.now() - launchTime;
      const reason = classifyAgentExitCode(code);
      lastExitClassification = reason;
      if (activeChild === child) {
        activeChild = null;
        activeAgentPid = null;
        try { writeControlFile(); } catch { failClosed('IPC_CONTROL_PUBLISH_FAILURE'); return; }
      }

      logger.log(`[DAEMON] Agent worker PID ${child.pid} exited (code=${code}, signal=${signal}, reason=${reason}, lived=${Math.round(lifespan / 1000)}s).`);

      if (isTerminating) return;

      if (code !== null && NON_RETRYABLE_EXIT_CODES.has(code)) {
        logger.log(`[DAEMON][FAIL_CLOSED] Non-retryable termination (${reason}, code=${code}). Auto-restart halted; Lock exists=${fs.existsSync(lockPath)}. Exiting daemon with 0.`);
        cleanupAndExit(0);
        return;
      }

      // Bounded supervisor lifetime budget: slow recurring failures must not evade the breaker.
      consecutiveRapidExits++;

      if (consecutiveRapidExits >= cfg.maxRapidRestarts) {
        logger.log(`[DAEMON][CIRCUIT_BREAKER] Detected ${consecutiveRapidExits} unexpected worker exits (limit=${cfg.maxRapidRestarts}). Halting auto-restart fail-closed; exiting daemon with 0.`);
        cleanupAndExit(0);
        return;
      }

      const delay = Math.min(30000, Math.round(3000 * Math.pow(1.5, Math.max(0, consecutiveRapidExits - 1))));
      logger.log(`[DAEMON][RESTART] Transient failure (${reason}); restarting in ${(delay / 1000).toFixed(1)}s (rapidCrashCount=${consecutiveRapidExits}/${cfg.maxRapidRestarts})...`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startAgent();
      }, delay);
    });

    child.on('error', (err) => {
      logger.log(`[DAEMON] Child spawn error: ${redactSensitiveLogLine(err.message)}`);
    });
    try { writeControlFile(); } catch { failClosed('IPC_CONTROL_PUBLISH_FAILURE'); }
  }

  async function handleIpcRequest(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) return { response: { ok: false, error: 'INVALID_REQUEST' } };
    if (!constantTimeTokenMatch(req.token, ipcSecret)) return { response: { ok: false, error: 'UNAUTHORIZED' } };
    if (typeof req.deviceId !== 'string' || req.deviceId.toLowerCase() !== deviceId.toLowerCase()) {
      return { response: { ok: false, error: 'DEVICE_MISMATCH' } };
    }
    if (req.action === 'STATUS') {
      let lockOwnerPid = null;
      try { if (fs.existsSync(lockPath)) lockOwnerPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid ?? null; } catch {}
      return { response: {
        ok: true, daemonPid: process.pid, startedAt: daemonStartedAt, agentPid: activeAgentPid,
        deviceId, instanceId, agentName: agentName || `Local-Agent-${os.hostname()}`,
        releaseDir: cfg.releaseDir, configDir: cfg.configDir, logFile: logger.logFile,
        lockPath, lockExists: fs.existsSync(lockPath), lockOwnerPid, isTerminating,
        consecutiveRapidExits, lastExitClassification, uptimeMs: Date.now() - daemonStartedAt
      }};
    }
    if (req.action === 'SHUTDOWN') {
      const result = await initiateGracefulShutdown('IPC SHUTDOWN', req.timeoutMs);
      return { response: { ...result, deviceId, daemonPid: process.pid, instanceId }, shutdown: true };
    }
    return { response: { ok: false, error: 'FORBIDDEN_ACTION' } };
  }

  function failClosed(reason) {
    logger.log(`[DAEMON][FAIL_CLOSED] ${reason}; stopping target worker.`);
    void initiateGracefulShutdown(reason).then(() => cleanupAndExit(0));
  }

  if (ipcTransport === 'mailbox') {
    // Windows Node net.createServer cannot specify a per-user named-pipe DACL.
    // The local IPC endpoint is instead an exclusively owned, SID-restricted mailbox.
    // No TCP or named-pipe listener is created on Windows.
    mailboxTimer = setInterval(async () => {
      if (mailboxBusy) return;
      mailboxBusy = true;
      try {
        const requests = fs.readdirSync(ipcEndpoint).filter(name => /^req-[a-f0-9]{32}\.json$/.test(name)).slice(0, 16);
        for (const name of requests) {
          const requestPath = path.join(ipcEndpoint, name);
          const responsePath = path.join(ipcEndpoint, name.replace(/^req-/, 'resp-'));
          let req;
          try { req = readBoundedJson(requestPath, 4096); } catch {
            try { fs.unlinkSync(requestPath); } catch {}
            continue;
          }
          // Consume once; never repeat a request after handling it.
          try { fs.unlinkSync(requestPath); } catch { continue; }
          const result = await handleIpcRequest(req);
          atomicJson(responsePath, result.response);
          if (result.shutdown) { cleanupAndExit(0); return; }
        }
      } catch {
        failClosed('IPC_MAILBOX_FAILURE');
      } finally { mailboxBusy = false; }
    }, 100);
    try {
      writeControlFile();
      logger.log('[DAEMON] Private Windows IPC mailbox ready.');
      startAgent();
    } catch { failClosed('IPC_INITIALIZATION_FAILURE'); }
  } else {
    ipcServer = net.createServer((socket) => {
      let buffer = '';
      let handled = false;
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', async (chunk) => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > 4096) {
          handled = true;
          socket.end(JSON.stringify({ ok: false, error: 'PAYLOAD_TOO_LARGE' }) + '\n');
          return;
        }
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        handled = true;
        socket.setTimeout(0);
        let req;
        try { req = JSON.parse(buffer.slice(0, nl)); } catch {
          socket.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }) + '\n');
          return;
        }
        try {
          const result = await handleIpcRequest(req);
          if (result.shutdown) {
            const finish = () => cleanupAndExit(0);
            socket.once('close', finish);
            socket.end(JSON.stringify(result.response) + '\n', finish);
            setTimeout(finish, 1000).unref();
          } else socket.end(JSON.stringify(result.response) + '\n');
        } catch { failClosed('IPC_REQUEST_FAILURE'); }
      });
    });
    ipcServer.on('error', () => failClosed('IPC_SERVER_FAILURE'));
    ipcServer.listen(ipcEndpoint, () => {
      ownsIpcEndpoint = true;
      try {
        fs.chmodSync(ipcEndpoint, 0o600);
        writeControlFile();
        logger.log('[DAEMON] Private local IPC socket ready.');
        startAgent();
      } catch { failClosed('IPC_INITIALIZATION_FAILURE'); }
    });
  }

  process.on('SIGINT', () => {
    void initiateGracefulShutdown('SIGINT').then(() => cleanupAndExit(0));
  });

  process.on('SIGTERM', () => {
    void initiateGracefulShutdown('SIGTERM').then(() => cleanupAndExit(0));
  });
}

try { main(); } catch {
  // Configuration and initialization errors require operator correction, not scheduler retries.
  console.error('[DAEMON][FAIL_CLOSED] Unable to initialize service configuration or supervisor.');
  process.exitCode = 0;
}
