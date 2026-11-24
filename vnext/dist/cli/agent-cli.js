"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("../local-agent/client");
const dotenv_1 = __importDefault(require("dotenv"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
dotenv_1.default.config();
async function main() {
    const gatewayUrl = process.env.GATEWAY_URL || 'ws://localhost:4000/ws/agent';
    const deviceId = process.env.AGENT_ID;
    const token = process.env.AGENT_TOKEN;
    const allowRawShell = process.env.ALLOW_RAW_SHELL === 'true';
    // Parse CLI args for --projects-config or --config
    let projectsConfigFile = process.env.LOCAL_PROJECTS_CONFIG || process.env.PROJECTS_CONFIG;
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--projects-config' || args[i] === '--config') && args[i + 1]) {
            projectsConfigFile = args[i + 1];
            i++;
        }
    }
    // If not explicitly specified, check for default ./projects.json
    if (!projectsConfigFile && fs.existsSync(path.resolve('projects.json'))) {
        projectsConfigFile = path.resolve('projects.json');
    }
    const allowedWorkspaces = process.env.ALLOWED_WORKSPACES
        ? process.env.ALLOWED_WORKSPACES.split(',').map(s => s.trim())
        : (projectsConfigFile ? undefined : [process.cwd()]);
    if (!deviceId || !token) {
        console.error('ERROR: AGENT_ID and AGENT_TOKEN must be specified in .env or environment variables');
        process.exit(1);
    }
    console.log('====================================================');
    console.log('       DevSpace Ultra - Local Outbound Agent        ');
    console.log('====================================================');
    console.log(`Gateway URL        : ${gatewayUrl}`);
    console.log(`Device ID          : ${deviceId}`);
    if (projectsConfigFile) {
        console.log(`Projects Config    : ${projectsConfigFile}`);
    }
    if (allowedWorkspaces) {
        console.log(`Legacy Workspaces  : ${allowedWorkspaces.join(', ')}`);
    }
    console.log(`Allow Raw Shell    : ${allowRawShell}`);
    console.log('----------------------------------------------------');
    const agent = new client_1.LocalAgentClient({
        gatewayUrl,
        deviceId,
        token,
        projectsConfigFile: projectsConfigFile ? path.resolve(projectsConfigFile) : undefined,
        allowedWorkspaces,
        allowRawShell
    });
    // Per-user, per-device exclusive CLI ownership. A crashed process may leave
    // the lock; never auto-take over an unverified executor or child process.
    const lockDir = path.join(os.homedir(), '.devspace-ultra', 'agent-locks');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const lockName = crypto.createHash('sha256').update(deviceId.toLowerCase()).digest('hex');
    const lockPath = path.join(lockDir, `${lockName}.lock`);
    const lockOwner = JSON.stringify({ pid: process.pid, deviceId, startedAt: Date.now(), nonce: crypto.randomUUID() });
    try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, lockOwner);
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch (err) {
        if (err?.code === 'EEXIST') {
            throw new Error(`Agent lock already exists: ${lockPath}. Verify the previous agent AND its child processes have stopped and reconcile uncertain tasks before manual lock recovery.`);
        }
        throw err;
    }
    process.once('exit', () => {
        if (agent.hasInFlightTasks())
            return;
        try {
            if (fs.readFileSync(lockPath, 'utf8') === lockOwner)
                fs.unlinkSync(lockPath);
        }
        catch { /* Leave an unverifiable lock intact. */ }
    });
    agent.start();
    console.log('[AGENT] Local Agent connected outbound. Waiting for tasks...');
    let isTerminating = false;
    const handleShutdown = async (signal) => {
        if (isTerminating)
            return;
        isTerminating = true;
        console.log(`\n[AGENT] Received ${signal}, stopping agent gracefully...`);
        try {
            await agent.stop({ timeoutMs: 3000 });
            console.log('[AGENT] Agent stopped cleanly.');
        }
        catch (err) {
            console.error('[AGENT] Error during shutdown:', err);
        }
        finally {
            process.exit(0);
        }
    };
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}
main().catch((err) => {
    console.error('Fatal error starting Agent:', err);
    process.exit(1);
});
