const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

function parseArgs(argv) {
  const command = argv[0];
  const opts = { command, json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--device-id' && next) { opts.deviceId = next; i++; }
    else if (a === '--config-dir' && next) { opts.configDir = next; i++; }
    else if (a === '--timeout-ms' && next) { opts.timeoutMs = Number(next); i++; }
    else if (a === '--json') { opts.json = true; }
  }
  return opts;
}

function readDeviceIdFromEnv(envPath) {
  if (!fs.existsSync(envPath)) return undefined;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*AGENT_ID\s*=\s*(.+)\s*$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function resolveControlFile(opts) {
  const controlDir = process.env.DEVSPACE_AGENT_CONTROL_DIR
    ? path.resolve(process.env.DEVSPACE_AGENT_CONTROL_DIR)
    : path.join(os.homedir(), '.devspace-ultra', 'agent-control');

  let deviceId = opts.deviceId;
  if (!deviceId && opts.configDir) {
    deviceId = readDeviceIdFromEnv(path.join(path.resolve(opts.configDir), '.env'));
  }
  if (!deviceId) {
    deviceId = readDeviceIdFromEnv(path.resolve(__dirname, '..', '..', '.env'));
  }

  if (deviceId) {
    const hash = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');
    const controlPath = path.join(controlDir, `${hash}.control.json`);
    if (!fs.existsSync(controlPath)) {
      return { error: `CONTROL_NOT_FOUND: No active control record for device '${deviceId}' at '${controlPath}'.` };
    }
    return { controlPath, control: JSON.parse(fs.readFileSync(controlPath, 'utf8')) };
  }

  if (!fs.existsSync(controlDir)) {
    return { error: `CONTROL_NOT_FOUND: Control directory does not exist: '${controlDir}'.` };
  }

  const files = fs.readdirSync(controlDir).filter(f => f.endsWith('.control.json'));
  if (files.length === 0) {
    return { error: 'CONTROL_NOT_FOUND: No active DevSpace Ultra agent control files found.' };
  }
  if (files.length > 1) {
    return { error: 'AMBIGUOUS_DEVICE: Multiple control files found; specify --device-id or --config-dir.' };
  }

  const controlPath = path.join(controlDir, files[0]);
  return { controlPath, control: JSON.parse(fs.readFileSync(controlPath, 'utf8')) };
}

function sendIpcRequest(endpoint, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      reject(new Error(`IPC_TIMEOUT: Timed out waiting for daemon IPC response after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify(payload) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl).trim()));
        } catch (err) {
          reject(err);
        } finally {
          socket.end();
        }
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command || !['status', 'shutdown'].includes(opts.command)) {
    console.error('Usage: node ipc-control.js <status|shutdown> [--device-id <id>] [--config-dir <dir>] [--timeout-ms <ms>] [--json]');
    process.exit(2);
  }

  const resolved = resolveControlFile(opts);
  if (resolved.error) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: resolved.error }));
    else console.error(resolved.error);
    process.exit(1);
  }

  const ctrl = resolved.control;
  const action = opts.command === 'shutdown' ? 'SHUTDOWN' : 'STATUS';
  const reqTimeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10000;
  const ipcWaitMs = action === 'SHUTDOWN' ? reqTimeoutMs + 6000 : 5000;

  try {
    const resp = await sendIpcRequest(
      ctrl.ipcEndpoint,
      {
        action,
        token: ctrl.ipcSecret,
        deviceId: ctrl.deviceId,
        ...(action === 'SHUTDOWN' ? { timeoutMs: reqTimeoutMs } : {})
      },
      ipcWaitMs
    );
    if (opts.json) {
      console.log(JSON.stringify(resp));
    } else {
      console.log(JSON.stringify(resp, null, 2));
    }
    process.exit(resp && resp.ok ? 0 : 1);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg, daemonPid: ctrl.daemonPid, agentPid: ctrl.agentPid, lockPath: ctrl.lockPath }));
    else console.error(msg);
    process.exit(1);
  }
}

main();
