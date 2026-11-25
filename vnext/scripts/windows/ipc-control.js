const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { resolveConfiguration, resolveIdentity } = require('./service-config');
const { assertPrivateDirectory, assertPrivateFile, readBoundedJson, mailboxPath, sendMailboxRequest } = require('./ipc-security');

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
    deviceId = resolveIdentity(resolveConfiguration([]));
  }

  if (deviceId) {
    const hash = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');
    const controlPath = path.join(controlDir, `${hash}.control.json`);
    if (!fs.existsSync(controlPath)) {
      return { error: `CONTROL_NOT_FOUND: No active control record for device '${deviceId}' at '${controlPath}'.` };
    }
    assertPrivateDirectory(controlDir);
    assertPrivateFile(controlPath);
    const control = readBoundedJson(controlPath, 65536);
    if (!control.deviceId || control.deviceId.toLowerCase() !== deviceId.toLowerCase()) return { error: 'DEVICE_MISMATCH: control record belongs to another device.' };
    const ownerPath = path.join(controlDir, `${hash}.daemon.lock`);
    assertPrivateFile(ownerPath);
    const owner = readBoundedJson(ownerPath, 4096);
    if (owner.daemonPid !== control.daemonPid || owner.deviceId !== control.deviceId || owner.instanceId !== control.instanceId ||
        !Number.isInteger(control.daemonPid) || control.daemonPid <= 0 || !/^[a-f0-9]{64}$/.test(control.ipcSecret || '')) {
      return { error: 'IPC_IDENTITY_INVALID: control ownership not verified.' };
    }
    try { process.kill(control.daemonPid, 0); } catch { return { error: 'IPC_OWNER_NOT_LIVE: operator reconciliation required.' }; }
    if (process.platform === 'win32') {
      if (control.ipcTransport !== 'mailbox' || path.resolve(control.ipcEndpoint) !== mailboxPath(controlDir, hash, control.instanceId)) return { error: 'IPC_ENDPOINT_INVALID' };
      assertPrivateDirectory(control.ipcEndpoint);
    } else {
      const userName = (process.env.USERNAME || process.env.USER || os.userInfo().username || 'user').toLowerCase();
      const userHash = crypto.createHash('sha256').update(userName).digest('hex').slice(0, 12);
      const expected = path.join(controlDir, `${userHash}-${hash.slice(0, 16)}.sock`);
      const stat = fs.lstatSync(expected);
      if (control.ipcTransport !== 'socket' || control.ipcEndpoint !== expected || !stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return { error: 'IPC_ENDPOINT_INVALID' };
    }
    return { controlPath, control };
  }

  return { error: 'IDENTITY_REQUIRED: specify --device-id or configure an explicit service identity.' };
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

  let resolved;
  try { resolved = resolveControlFile(opts); } catch {
    resolved = { error: 'IPC_CONTROL_UNVERIFIED: private path, identity, or ownership validation failed.' };
  }
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
    const send = ctrl.ipcTransport === 'mailbox' ? sendMailboxRequest : sendIpcRequest;
    const resp = await send(
      ctrl.ipcEndpoint,
      {
        action,
        token: ctrl.ipcSecret,
        deviceId: ctrl.deviceId,
        ...(action === 'SHUTDOWN' ? { timeoutMs: reqTimeoutMs } : {})
      },
      ipcWaitMs
    );
    if (resp && resp.ok && (resp.deviceId !== ctrl.deviceId || resp.daemonPid !== ctrl.daemonPid || resp.instanceId !== ctrl.instanceId)) throw new Error('IPC_RESPONSE_IDENTITY_MISMATCH');
    if (ctrl.ipcTransport === 'mailbox' && action === 'SHUTDOWN' && resp && resp.ok) {
      try { fs.rmdirSync(ctrl.ipcEndpoint); } catch {}
    }
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
