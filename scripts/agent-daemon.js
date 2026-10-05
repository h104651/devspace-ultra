const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const vnextDir = 'C:\\Users\\testuser\\AppData\\Local\\devspace-ultra-src\\vnext';
const logDir = path.join(__dirname, '..', 'logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(logDir, 'agent-daemon.log');

function log(msg) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
}

log('=== DevSpace Ultra Local Agent Background Daemon Started ===');

// Load .env explicitly
const envPath = path.join(vnextDir, '.env');
const fileEnv = {};
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        fileEnv[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
}

const combinedEnv = {
  ...process.env,
  ...fileEnv
};

let isTerminating = false;
let consecutiveRapidExits = 0;

function startAgent() {
  if (isTerminating) return;

  const launchTime = Date.now();
  log('Starting agent-cli process...');
  const child = spawn(process.execPath, [path.join(vnextDir, 'dist', 'cli', 'agent-cli.js')], {
    cwd: vnextDir,
    env: combinedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  log(`Agent process started with PID: ${child.pid}`);

  child.stdout.on('data', (d) => {
    fs.appendFileSync(logFile, d.toString());
  });

  child.stderr.on('data', (d) => {
    fs.appendFileSync(logFile, `[STDERR] ${d.toString()}`);
  });

  child.on('exit', (code, signal) => {
    const lifespan = Date.now() - launchTime;
    log(`Agent process exited with code ${code}, signal ${signal} (lived ${Math.round(lifespan / 1000)}s).`);
    if (isTerminating) return;

    if (lifespan < 5000) {
      consecutiveRapidExits++;
    } else {
      consecutiveRapidExits = 0;
    }

    if (consecutiveRapidExits >= 5) {
      log(`[THROTTLE] Detected ${consecutiveRapidExits} rapid exits under 5s. Throttling restart to 30s to prevent CPU overload...`);
      consecutiveRapidExits = 0;
      setTimeout(startAgent, 30000);
    } else {
      const delay = Math.min(15000, 3000 * Math.pow(1.5, consecutiveRapidExits));
      log(`Auto-restarting agent in ${(delay / 1000).toFixed(1)}s (rapid exit count: ${consecutiveRapidExits})...`);
      setTimeout(startAgent, delay);
    }
  });

  child.on('error', (e) => {
    log(`Child process error: ${e.message}`);
  });
}

process.on('SIGINT', () => {
  isTerminating = true;
  log('Received SIGINT. Shutting down daemon...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  isTerminating = true;
  log('Received SIGTERM. Shutting down daemon...');
  process.exit(0);
});

startAgent();
