import { LocalAgentClient } from '../local-agent/client';
import {
  AGENT_EXIT_CODES,
  redactSensitiveLogLine,
  stripSensitiveEnvInPlace
} from '../local-agent/service-exit-codes';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

function parseCliArgs(argv: string[]): {
  projectsConfigArg?: string;
  envFileArg?: string;
  configDirArg?: string;
  nameArg?: string;
} {
  let projectsConfigArg: string | undefined;
  let envFileArg: string | undefined;
  let configDirArg: string | undefined;
  let nameArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--projects-config' || arg === '--config') && next) {
      projectsConfigArg = next;
      i++;
    } else if (arg === '--env-file' && next) {
      envFileArg = next;
      i++;
    } else if (arg === '--config-dir' && next) {
      configDirArg = next;
      i++;
    } else if (arg === '--name' && next) {
      nameArg = next;
      i++;
    }
  }

  return { projectsConfigArg, envFileArg, configDirArg, nameArg };
}

function resolveFileInConfigDir(filePath: string, configDir?: string): string {
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  if (configDir) {
    const inConfig = path.resolve(configDir, filePath);
    if (fs.existsSync(inConfig)) return inConfig;
  }
  return path.resolve(filePath);
}

async function main() {
  const { projectsConfigArg, envFileArg, configDirArg, nameArg } = parseCliArgs(process.argv.slice(2));
  const configDir = (configDirArg || process.env.DEVSPACE_CONFIG_DIR)
    ? path.resolve(configDirArg || process.env.DEVSPACE_CONFIG_DIR!)
    : undefined;

  const explicitEnvFile = envFileArg || process.env.DEVSPACE_ENV_FILE;
  const envPath = explicitEnvFile
    ? path.resolve(explicitEnvFile)
    : (configDir ? path.join(configDir, '.env') : undefined);

  if (envPath) {
    if (!fs.existsSync(envPath)) {
      console.error(`[AGENT][CONFIG_ERROR] Specified env file does not exist: ${envPath}`);
      process.exit(AGENT_EXIT_CODES.CONFIG_ERROR);
    }
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }

  // Defense-in-depth: never retain unnecessary administrative or cloud secrets in worker process.env
  const stripped = stripSensitiveEnvInPlace(process.env);
  if (stripped.length > 0) {
    console.warn(`[AGENT][SECURITY] Stripped unnecessary sensitive env vars from worker environment: ${stripped.join(', ')}`);
  }

  const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:4000/ws/agent';
  const deviceId = process.env.AGENT_ID?.trim();
  const token = process.env.AGENT_TOKEN?.trim();
  const agentName = (nameArg || process.env.AGENT_NAME)?.trim() || undefined;
  const allowRawShell = process.env.ALLOW_RAW_SHELL === 'true';

  let projectsConfigFile = projectsConfigArg || process.env.LOCAL_PROJECTS_CONFIG || process.env.PROJECTS_CONFIG;
  if (projectsConfigFile) {
    projectsConfigFile = resolveFileInConfigDir(projectsConfigFile, configDir);
  } else {
    const defaultInConfig = configDir ? path.join(configDir, 'projects.json') : undefined;
    if (defaultInConfig && fs.existsSync(defaultInConfig)) {
      projectsConfigFile = defaultInConfig;
    } else if (fs.existsSync(path.resolve('projects.json'))) {
      projectsConfigFile = path.resolve('projects.json');
    }
  }

  const allowedWorkspaces = process.env.ALLOWED_WORKSPACES
    ? process.env.ALLOWED_WORKSPACES.split(',').map(s => s.trim())
    : (projectsConfigFile ? undefined : [process.cwd()]);

  if (!deviceId || !token) {
    console.error('[AGENT][CONFIG_ERROR] AGENT_ID and AGENT_TOKEN must be specified in .env or environment variables');
    process.exit(AGENT_EXIT_CODES.CONFIG_ERROR);
  }

  let isTerminating = false;
  let agent!: LocalAgentClient;
  let lockPath = '';
  let lockOwner = '';

  const defaultShutdownTimeoutMs = Math.min(
    30000,
    Math.max(500, Number(process.env.DEVSPACE_SHUTDOWN_TIMEOUT_MS) || 10000)
  );

  const performShutdown = async (
    reason: string,
    options?: { timeoutMs?: number; exitCodeOnClean?: number }
  ) => {
    if (isTerminating) return;
    isTerminating = true;
    const timeoutMs = Math.min(30000, Math.max(500, options?.timeoutMs ?? defaultShutdownTimeoutMs));
    console.log(`\n[AGENT] Received ${reason}, stopping agent gracefully (timeout=${timeoutMs}ms)...`);

    try {
      await agent.stop({ timeoutMs });
    } catch (err: any) {
      console.error('[AGENT] Error during shutdown:', redactSensitiveLogLine(err?.message || String(err)));
    }

    const remaining = agent.getInFlightTasks();
    if (remaining.length > 0) {
      const mutationCount = remaining.filter(t => t.isMutation).length;
      const taskSummary = remaining.map(t => `${t.taskId}(${t.capability}${t.isMutation ? ':mutation' : ''})`).join(', ');
      console.error(
        `[AGENT][SHUTDOWN_TIMEOUT] Timed out waiting for ${remaining.length} in-flight task(s) (mutations=${mutationCount}): ${taskSummary}. Preserving lock for manual audit: ${lockPath}`
      );
      process.exit(AGENT_EXIT_CODES.SHUTDOWN_TIMEOUT);
    }

    console.log('[AGENT] Agent stopped cleanly.');
    process.exit(options?.exitCodeOnClean ?? AGENT_EXIT_CODES.CLEAN);
  };

  try {
    agent = new LocalAgentClient({
      gatewayUrl,
      deviceId,
      token,
      name: agentName,
      projectsConfigFile: projectsConfigFile ? path.resolve(projectsConfigFile) : undefined,
      allowedWorkspaces,
      allowRawShell,
      onPolicyRejected: (policyReason: string) => {
        void performShutdown(`gateway policy rejection (${redactSensitiveLogLine(policyReason)})`, {
          timeoutMs: 3000,
          exitCodeOnClean: AGENT_EXIT_CODES.POLICY_REJECTED
        });
      }
    });
  } catch (err: any) {
    console.error('[AGENT][CONFIG_ERROR] Failed to initialize agent configuration:', redactSensitiveLogLine(err?.message || String(err)));
    process.exit(AGENT_EXIT_CODES.CONFIG_ERROR);
  }

  console.log('====================================================');
  console.log('       DevSpace Ultra - Local Outbound Agent        ');
  console.log('====================================================');
  console.log(`Gateway URL        : ${gatewayUrl}`);
  console.log(`Device ID          : ${deviceId}`);
  console.log(`Device Name        : ${agentName || `Local-Agent-${os.hostname()} (default)`}`);
  if (configDir) {
    console.log(`Config Directory   : ${configDir}`);
  }
  if (projectsConfigFile) {
    console.log(`Projects Config    : ${projectsConfigFile}`);
  }
  if (allowedWorkspaces) {
    console.log(`Legacy Workspaces  : ${allowedWorkspaces.join(', ')}`);
  }
  console.log(`Allow Raw Shell    : ${allowRawShell}`);
  console.log('----------------------------------------------------');

  // Per-user, per-device exclusive CLI ownership. A crashed process may leave
  // the lock; never auto-take over an unverified executor or child process.
  const lockDir = process.env.DEVSPACE_AGENT_LOCK_DIR
    ? path.resolve(process.env.DEVSPACE_AGENT_LOCK_DIR)
    : path.join(os.homedir(), '.devspace-ultra', 'agent-locks');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockName = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');
  lockPath = path.join(lockDir, `${lockName}.lock`);
  lockOwner = JSON.stringify({ pid: process.pid, deviceId, startedAt: Date.now(), nonce: crypto.randomUUID() });

  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, lockOwner); } finally { fs.closeSync(fd); }
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      console.error(
        `[AGENT][LOCK_CONFLICT] Agent lock already exists: ${lockPath}. Verify the previous agent AND its child processes have stopped and reconcile uncertain tasks before manual lock recovery.`
      );
      process.exit(AGENT_EXIT_CODES.LOCK_CONFLICT);
    }
    throw err;
  }

  process.once('exit', () => {
    if (agent.hasInFlightTasks()) return;
    try {
      if (fs.readFileSync(lockPath, 'utf8') === lockOwner) fs.unlinkSync(lockPath);
    } catch { /* Leave an unverifiable lock intact. */ }
  });

  agent.start();
  console.log(`[AGENT] Lock acquired: ${lockPath} (pid=${process.pid})`);
  console.log('[AGENT] Local Agent connected outbound. Waiting for tasks...');

  try {
    if (typeof process.send === 'function') {
      process.send({ type: 'AGENT_STARTED', pid: process.pid, deviceId, lockPath });
    }
  } catch {}

  process.on('SIGINT', () => { void performShutdown('SIGINT'); });
  process.on('SIGTERM', () => { void performShutdown('SIGTERM'); });
  process.on('message', (msg: any) => {
    if (msg && typeof msg === 'object' && msg.type === 'SHUTDOWN') {
      const requestedTimeout = typeof msg.timeoutMs === 'number' ? msg.timeoutMs : undefined;
      void performShutdown('IPC SHUTDOWN', { timeoutMs: requestedTimeout });
    }
  });
}

main().catch((err) => {
  console.error('Fatal error starting Agent:', redactSensitiveLogLine(err?.message || String(err)));
  process.exit(AGENT_EXIT_CODES.TRANSIENT_FAILURE);
});
