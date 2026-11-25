const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--release-dir' && next) { parsed.releaseDir = next; i++; }
    else if (a === '--config-dir' && next) { parsed.configDir = next; i++; }
    else if (a === '--log-dir' && next) { parsed.logDir = next; i++; }
    else if (a === '--env-file' && next) { parsed.envFile = next; i++; }
    else if (a === '--service-config' && next) { parsed.serviceConfig = next; i++; }
    else if (a === '--shutdown-timeout-ms' && next) { parsed.shutdownTimeoutMs = Number(next); i++; }
  }
  return parsed;
}

function loadDotEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

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

function resolveConfiguration() {
  const cli = parseArgs(process.argv.slice(2));
  const defaultReleaseDir = path.resolve(__dirname, '..', '..');

  const serviceConfigPath = path.resolve(
    cli.serviceConfig || process.env.DEVSPACE_SERVICE_CONFIG || path.join(__dirname, 'service-config.json')
  );
  let serviceCfg = {};
  if (fs.existsSync(serviceConfigPath)) {
    serviceCfg = JSON.parse(fs.readFileSync(serviceConfigPath, 'utf8'));
  }

  const releaseDir = path.resolve(
    cli.releaseDir || process.env.DEVSPACE_RELEASE_DIR || serviceCfg.releaseDir || defaultReleaseDir
  );
  const configDir = path.resolve(
    cli.configDir || process.env.DEVSPACE_CONFIG_DIR || serviceCfg.configDir || releaseDir
  );
  const logDir = path.resolve(
    cli.logDir || process.env.DEVSPACE_LOG_DIR || serviceCfg.logDir || path.join(configDir, 'logs')
  );
  const envPath = path.resolve(
    cli.envFile || process.env.DEVSPACE_ENV_FILE || serviceCfg.envFile || path.join(configDir, '.env')
  );

  const maxLogBytes = Math.max(1024, Number(process.env.DEVSPACE_LOG_MAX_BYTES || serviceCfg.maxLogBytes) || 10 * 1024 * 1024);
  const maxLogFiles = Math.max(1, Number(process.env.DEVSPACE_LOG_MAX_FILES || serviceCfg.maxLogFiles) || 5);
  const maxRapidRestarts = Math.max(1, Number(process.env.DEVSPACE_MAX_RAPID_RESTARTS || serviceCfg.maxRapidRestarts) || 5);
  const shutdownTimeoutMs = Math.min(30000, Math.max(500, Number(cli.shutdownTimeoutMs || process.env.DEVSPACE_SHUTDOWN_TIMEOUT_MS || serviceCfg.shutdownTimeoutMs) || 10000));

  return {
    releaseDir,
    configDir,
    logDir,
    envPath,
    maxLogBytes,
    maxLogFiles,
    maxRapidRestarts,
    shutdownTimeoutMs
  };
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
  const fileEnv = loadDotEnvFile(cfg.envPath);
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

  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });

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

  const { deviceHash, endpoint: ipcEndpoint } = buildIpcEndpoint(controlDir, deviceId);
  const lockPath = path.join(lockDir, `${deviceHash}.lock`);
  const controlPath = path.join(controlDir, `${deviceHash}.control.json`);

  // Check if another daemon is already alive for this device
  if (fs.existsSync(controlPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
      if (existing && existing.daemonPid && existing.daemonPid !== process.pid && isProcessAlive(existing.daemonPid)) {
        logger.log(`[DAEMON][FAIL_CLOSED] Duplicate daemon detected (PID: ${existing.daemonPid}) for device '${deviceId}'. Exiting cleanly.`);
        process.exit(0);
      }
    } catch {
      // Unparseable stale control file; will verify lock state on child start
    }
  }

  if (process.platform !== 'win32' && fs.existsSync(ipcEndpoint)) {
    try { fs.unlinkSync(ipcEndpoint); } catch {}
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

  function writeControlFile() {
    const payload = {
      daemonPid: process.pid,
      agentPid: activeAgentPid,
      deviceId,
      user: process.env.USERNAME || process.env.USER || os.userInfo().username,
      ipcEndpoint,
      ipcSecret,
      releaseDir: cfg.releaseDir,
      configDir: cfg.configDir,
      lockPath,
      startedAt: daemonStartedAt
    };
    fs.writeFileSync(controlPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  }

  function removeOwnControlFile() {
    try {
      if (!fs.existsSync(controlPath)) return;
      const cur = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
      if (cur && cur.daemonPid === process.pid && cur.ipcSecret === ipcSecret) {
        fs.unlinkSync(controlPath);
      }
    } catch {}
    if (process.platform !== 'win32' && fs.existsSync(ipcEndpoint)) {
      try { fs.unlinkSync(ipcEndpoint); } catch {}
    }
  }

  function cleanupAndExit(exitCode = 0) {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    removeOwnControlFile();
    if (ipcServer) {
      try { ipcServer.close(); } catch {}
      ipcServer = null;
    }
    process.exit(exitCode);
  }

  function initiateGracefulShutdown(reason, requestedTimeoutMs) {
    return new Promise((resolve) => {
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

      child.once('exit', (code, signal) => {
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
    writeControlFile();
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
        activeAgentPid = msg.pid || child.pid;
        writeControlFile();
        logger.log(`[DAEMON] Lock ownership confirmed for PID ${activeAgentPid} (${msg.lockPath || lockPath}).`);
      }
    });

    child.on('exit', (code, signal) => {
      const lifespan = Date.now() - launchTime;
      const reason = classifyAgentExitCode(code);
      lastExitClassification = reason;
      if (activeChild === child) {
        activeChild = null;
        activeAgentPid = null;
        writeControlFile();
      }

      logger.log(`[DAEMON] Agent worker PID ${child.pid} exited (code=${code}, signal=${signal}, reason=${reason}, lived=${Math.round(lifespan / 1000)}s).`);

      if (isTerminating) return;

      if (code !== null && NON_RETRYABLE_EXIT_CODES.has(code)) {
        logger.log(`[DAEMON][FAIL_CLOSED] Non-retryable termination (${reason}, code=${code}). Auto-restart halted; Lock exists=${fs.existsSync(lockPath)}. Exiting daemon with 0.`);
        cleanupAndExit(0);
        return;
      }

      if (lifespan < 15000) {
        consecutiveRapidExits++;
      } else {
        consecutiveRapidExits = 0;
      }

      if (consecutiveRapidExits >= cfg.maxRapidRestarts) {
        logger.log(`[DAEMON][CIRCUIT_BREAKER] Detected ${consecutiveRapidExits} rapid exits under 15s (limit=${cfg.maxRapidRestarts}). Halting auto-restart fail-closed; exiting daemon with 0.`);
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
  }

  ipcServer = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');

    const reply = (obj, closeAfter = true) => {
      try {
        socket.write(JSON.stringify(obj) + '\n');
      } catch {}
      if (closeAfter) {
        try { socket.end(); } catch {}
      }
    };

    socket.on('data', async (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > 4096) {
        logger.log('[DAEMON][IPC_REJECT] Oversized IPC payload rejected.');
        reply({ ok: false, error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const rawLine = buffer.slice(0, nl).trim();
      buffer = '';

      let req;
      try {
        req = JSON.parse(rawLine);
      } catch {
        logger.log('[DAEMON][IPC_REJECT] Malformed JSON on IPC channel.');
        reply({ ok: false, error: 'INVALID_JSON' });
        return;
      }

      if (!req || typeof req !== 'object' || Array.isArray(req)) {
        reply({ ok: false, error: 'INVALID_REQUEST' });
        return;
      }

      if (!constantTimeTokenMatch(req.token, ipcSecret)) {
        logger.log('[DAEMON][IPC_REJECT] Unauthorized IPC token rejected.');
        reply({ ok: false, error: 'UNAUTHORIZED' });
        return;
      }

      if (req.deviceId && String(req.deviceId).toLowerCase() !== deviceId.toLowerCase()) {
        logger.log(`[DAEMON][IPC_REJECT] Device mismatch on IPC channel (${req.deviceId}).`);
        reply({ ok: false, error: 'DEVICE_MISMATCH' });
        return;
      }

      if (req.action === 'STATUS') {
        let lockOwnerPid = null;
        try {
          if (fs.existsSync(lockPath)) {
            lockOwnerPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid ?? null;
          }
        } catch {}
        reply({
          ok: true,
          daemonPid: process.pid,
          agentPid: activeAgentPid,
          deviceId,
          agentName: agentName || `Local-Agent-${os.hostname()}`,
          releaseDir: cfg.releaseDir,
          configDir: cfg.configDir,
          logFile: logger.logFile,
          lockPath,
          lockExists: fs.existsSync(lockPath),
          lockOwnerPid,
          isTerminating,
          consecutiveRapidExits,
          lastExitClassification,
          uptimeMs: Date.now() - daemonStartedAt
        });
        return;
      }

      if (req.action === 'SHUTDOWN') {
        const result = await initiateGracefulShutdown('IPC SHUTDOWN', req.timeoutMs);
        reply(result);
        setImmediate(() => cleanupAndExit(0));
        return;
      }

      logger.log(`[DAEMON][IPC_REJECT] Unsupported IPC action '${String(req.action)}' rejected.`);
      reply({ ok: false, error: 'FORBIDDEN_ACTION' });
    });

    socket.on('error', () => {});
  });

  ipcServer.on('error', (err) => {
    logger.log(`[DAEMON][FAIL_CLOSED] IPC server error (${err.code || err.message}). Exiting cleanly.`);
    cleanupAndExit(0);
  });

  ipcServer.listen(ipcEndpoint, () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(ipcEndpoint, 0o600); } catch {}
    }
    writeControlFile();
    logger.log(`[DAEMON] Authenticated IPC control ready (${ipcEndpoint}).`);
    startAgent();
  });

  process.on('SIGINT', () => {
    void initiateGracefulShutdown('SIGINT').then(() => cleanupAndExit(0));
  });

  process.on('SIGTERM', () => {
    void initiateGracefulShutdown('SIGTERM').then(() => cleanupAndExit(0));
  });
}

main();
