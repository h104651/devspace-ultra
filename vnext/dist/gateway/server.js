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
exports.GatewayServer = void 0;
const express_1 = __importDefault(require("express"));
const http = __importStar(require("http"));
const cors_1 = __importDefault(require("cors"));
const ws_1 = require("ws");
const auth_manager_1 = require("../security/auth-manager");
const scope_checker_1 = require("../security/scope-checker");
const kill_switch_1 = require("../security/kill-switch");
const rate_limiter_1 = require("../security/rate-limiter");
const audit_logger_1 = require("../security/audit-logger");
const task_store_1 = require("../storage/task-store");
const artifact_store_1 = require("../storage/artifact-store");
const idempotency_store_1 = require("../storage/idempotency-store");
const backend_1 = require("../kaggle/backend");
const swarm_orchestrator_1 = require("../swarm/swarm-orchestrator");
const connection_manager_1 = require("./connection-manager");
const lease_monitor_1 = require("./lease-monitor");
const task_router_1 = require("./task-router");
const handlers_1 = require("../mcp/handlers");
const tools = __importStar(require("../mcp/tools"));
const reliability_tools_1 = require("../mcp/reliability-tools");
const task_1 = require("../types/task");
const protocol_1 = require("../mcp/protocol");
class GatewayServer {
    app;
    httpServer;
    wss;
    authManager;
    killSwitch;
    rateLimiter;
    auditLogger;
    taskStore;
    artifactStore;
    idempotencyStore;
    kaggleBackend;
    swarmOrchestrator;
    connectionManager;
    leaseMonitor;
    taskRouter;
    mcpHandlers;
    config;
    constructor(config = {}) {
        this.config = config;
        const storageDir = config.storageDir || '.devspace-storage';
        this.authManager = new auth_manager_1.AuthManager(config.masterSecret, storageDir);
        this.killSwitch = new kill_switch_1.KillSwitch(storageDir);
        this.rateLimiter = new rate_limiter_1.RateLimiter();
        this.auditLogger = new audit_logger_1.AuditLogger(storageDir);
        this.taskStore = new task_store_1.TaskStore(storageDir);
        this.artifactStore = new artifact_store_1.ArtifactStore(storageDir);
        this.idempotencyStore = new idempotency_store_1.IdempotencyStore(storageDir);
        this.kaggleBackend = new backend_1.KaggleBackend(this.taskStore, this.artifactStore, undefined, storageDir, config.kagglePollIntervalMs || 15000);
        if (config.kaggleMockMode)
            this.kaggleBackend.getClient().setMockMode(true);
        this.swarmOrchestrator = new swarm_orchestrator_1.SwarmOrchestrator(this.taskStore);
        this.connectionManager = new connection_manager_1.ConnectionManager(this.authManager, this.killSwitch, this.auditLogger, this.taskStore);
        this.leaseMonitor = new lease_monitor_1.LeaseMonitor(this.taskStore, this.connectionManager, this.auditLogger);
        this.taskRouter = new task_router_1.TaskRouter(this.taskStore, this.idempotencyStore, this.kaggleBackend, this.swarmOrchestrator, this.killSwitch, this.auditLogger, this.connectionManager, this.authManager);
        this.mcpHandlers = new handlers_1.McpHandlers(this);
        this.app = (0, express_1.default)();
        this.httpServer = http.createServer(this.app);
        this.wss = new ws_1.WebSocketServer({ server: this.httpServer, path: '/ws/agent' });
        this.setupMiddlewares();
        this.setupRoutes();
        this.setupWebSocket();
    }
    setupMiddlewares() {
        this.app.use((0, cors_1.default)({ exposedHeaders: ['MCP-Protocol-Version', 'WWW-Authenticate'] }));
        this.app.use(express_1.default.json({ limit: '10mb' }));
        this.app.use((req, res, next) => {
            const ip = req.ip || req.socket.remoteAddress || 'unknown';
            const rl = this.rateLimiter.isAllowed(ip);
            if (!rl.allowed)
                return res.status(429).json({ error: 'RATE_LIMITED', retryAfterMs: rl.retryAfterMs });
            next();
        });
    }
    authenticate(requiredScope) {
        return (req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith('Bearer '))
                return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Authorization header with Bearer token is required' });
            const validation = this.authManager.validateToken(authHeader.substring(7));
            if (!validation.valid || !validation.payload)
                return res.status(401).json({ error: 'AUTH_INVALID', message: validation.error || 'Token invalid or expired' });
            if (validation.payload.metadata?.purpose === 'refresh_token')
                return res.status(401).json({ error: 'AUTH_INVALID', message: 'Refresh tokens cannot be used as access tokens' });
            if (this.killSwitch.isClientRevoked(validation.payload.subjectId))
                return res.status(403).json({ error: 'CLIENT_REVOKED' });
            if (requiredScope && !scope_checker_1.ScopeChecker.hasScope(validation.payload.scopes, requiredScope))
                return res.status(403).json({ error: 'AUTH_FORBIDDEN', message: `Required scope '${requiredScope}' not granted` });
            req.auth = validation.payload;
            next();
        };
    }
    requestHeaders(req) {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (Array.isArray(value))
                for (const item of value)
                    headers.append(key, item);
            else if (value !== undefined)
                headers.set(key, String(value));
        }
        return headers;
    }
    getToolsList() {
        return [...tools.getCanonicalToolsList(), reliability_tools_1.REMOTE_TASK_WAIT_TOOL];
    }
    async callTool(name, args, caller) {
        switch (name) {
            case 'remote_task_submit': return this.mcpHandlers.handleRemoteTaskSubmit(args, caller);
            case 'remote_task_status': return this.mcpHandlers.handleRemoteTaskStatus(args, caller);
            case 'task_inventory': return this.mcpHandlers.handleTaskInventory(args, caller);
            case 'remote_task_wait': return (0, reliability_tools_1.handleRemoteTaskWait)(this.taskStore, args, caller.scopes);
            case 'remote_task_logs': return this.mcpHandlers.handleRemoteTaskLogs(args, caller);
            case 'remote_task_artifacts': return this.mcpHandlers.handleRemoteTaskArtifacts(args, caller);
            case 'remote_task_cancel': return this.mcpHandlers.handleRemoteTaskCancel(args, caller);
            case 'kaggle_run': return this.mcpHandlers.handleKaggleRun(args, caller);
            case 'kaggle_status': return this.mcpHandlers.handleKaggleStatus(args, caller);
            case 'kaggle_logs': return this.mcpHandlers.handleKaggleLogs(args, caller);
            case 'kaggle_result': return this.mcpHandlers.handleKaggleResult(args, caller);
            case 'kaggle_project_list': return this.mcpHandlers.handleKaggleProjectList(args, caller);
            case 'kaggle_project_get': return this.mcpHandlers.handleKaggleProjectGet(args, caller);
            case 'kaggle_project_source': return this.mcpHandlers.handleKaggleProjectSource(args, caller);
            case 'kaggle_project_files': return this.mcpHandlers.handleKaggleProjectFiles(args, caller);
            case 'kaggle_project_output': return this.mcpHandlers.handleKaggleProjectOutput(args, caller);
            case 'kaggle_project_logs': return this.mcpHandlers.handleKaggleProjectLogs(args, caller);
            case 'kaggle_project_continue': return this.mcpHandlers.handleKaggleProjectContinue(args, caller);
            case 'kaggle_project_restore': return this.mcpHandlers.handleKaggleProjectRestore(args, caller);
            case 'kaggle_workspace_get': return this.mcpHandlers.handleKaggleWorkspaceGet(args, caller);
            case 'kaggle_workspace_file': return this.mcpHandlers.handleKaggleWorkspaceFile(args, caller);
            case 'kaggle_dataset_file': return this.mcpHandlers.handleKaggleDatasetFile(args, caller);
            case 'kaggle_workspace_continue': return this.mcpHandlers.handleKaggleWorkspaceContinue(args, caller);
            case 'local_project_list': return this.mcpHandlers.handleLocalProjectList(args, caller);
            case 'local_project_status': return this.mcpHandlers.handleLocalProjectStatus(args, caller);
            case 'local_read_file': return this.mcpHandlers.handleLocalReadFile(args, caller);
            case 'local_write_file': return this.mcpHandlers.handleLocalWriteFile(args, caller);
            case 'local_patch_file': return this.mcpHandlers.handleLocalPatchFile(args, caller);
            case 'local_list_directory': return this.mcpHandlers.handleLocalListDirectory(args, caller);
            case 'local_find_files': return this.mcpHandlers.handleLocalFindFiles(args, caller);
            case 'local_search_text': return this.mcpHandlers.handleLocalSearchText(args, caller);
            case 'local_find_repositories': return this.mcpHandlers.handleLocalFindRepositories(args, caller);
            case 'local_create_directory': return this.mcpHandlers.handleLocalCreateDirectory(args, caller);
            case 'local_git_status': return this.mcpHandlers.handleLocalGitStatus(args, caller);
            case 'local_run_tests': return this.mcpHandlers.handleLocalRunTests(args, caller);
            case 'local_build_project': return this.mcpHandlers.handleLocalBuildProject(args, caller);
            case 'swarm_dispatch': return this.mcpHandlers.handleSwarmDispatch(args, caller);
            case 'swarm_status': return this.mcpHandlers.handleSwarmStatus(caller);
            case 'chat_swarm_dispatch': return this.mcpHandlers.handleChatSwarmDispatch(args, caller);
            case 'chat_swarm_status': return this.mcpHandlers.handleChatSwarmStatus(args, caller);
            case 'chat_swarm_claim': return this.mcpHandlers.handleChatSwarmClaim(args, caller);
            case 'chat_swarm_next': return this.mcpHandlers.handleChatSwarmNext(args, caller);
            case 'chat_swarm_submit': return this.mcpHandlers.handleChatSwarmSubmit(args, caller);
            case 'chat_swarm_cancel': return this.mcpHandlers.handleChatSwarmCancel(args, caller);
            case 'chat_swarm_wake_bridge': return this.mcpHandlers.handleChatSwarmWakeBridge(args, caller);
            case 'chat_swarm_runtime_status': return this.mcpHandlers.handleChatSwarmRuntimeStatus(caller);
            case 'device_status': return this.mcpHandlers.handleDeviceStatus(args, caller);
            case 'device_maintenance_check': return this.mcpHandlers.handleDeviceMaintenanceCheck(args, caller);
            case 'kill_switch_trigger': return this.mcpHandlers.handleKillSwitchTrigger(args, caller);
            default: throw Object.assign(new Error(`Tool '${name}' not found`), { mcpNotFound: true });
        }
    }
    setupRoutes() {
        this.app.get('/health', (_req, res) => res.json({ ok: true }));
        this.app.get('/admin/health', this.authenticate('admin:health'), (_req, res) => res.json({ status: 'healthy', service: 'devspace-ultra-gateway', version: '2.1.0', timestamp: Date.now(), connectedAgents: this.connectionManager.getConnectedAgents().length }));
        this.app.post('/admin/devices', this.authenticate('admin'), async (req, res) => {
            try {
                const { name, platform, capabilities, deviceId, expiresInMs } = req.body || {};
                if (!name || typeof name !== 'string') {
                    return res.status(400).json({ error: 'INVALID_ARGUMENT: name is required' });
                }
                const reg = this.authManager.registerDevice(name, platform || 'windows', capabilities, deviceId, expiresInMs);
                await this.killSwitch.unrevokeDevice(reg.deviceId);
                this.auditLogger.log({ actor: req.auth?.subjectId || 'admin', actorType: 'client', action: 'DEVICE_REGISTERED', resource: reg.deviceId, result: 'SUCCESS' });
                return res.status(201).json({
                    ok: true,
                    deviceId: reg.deviceId,
                    token: reg.token,
                    device: {
                        deviceId: reg.record.deviceId,
                        name: reg.record.name,
                        platform: reg.record.platform,
                        status: reg.record.status,
                        capabilities: reg.record.capabilities,
                        registeredAt: reg.record.registeredAt
                    },
                    message: 'Device registered successfully. Save token securely; it cannot be retrieved again.'
                });
            }
            catch (err) {
                const isConflict = err.message?.includes('DEVICE_ID_CONFLICT');
                return res.status(isConflict ? 409 : 400).json({ error: err.message });
            }
        });
        this.app.get('/admin/devices', this.authenticate('admin'), (_req, res) => {
            const connected = this.connectionManager.getConnectedAgents();
            const onlineIds = new Set(connected.map(c => c.deviceId));
            const devices = this.authManager.listDevices().map(d => ({
                deviceId: d.deviceId,
                name: d.name,
                platform: d.platform,
                status: d.status === 'revoked' ? 'revoked' : (onlineIds.has(d.deviceId) ? 'online' : 'offline'),
                capabilities: d.capabilities,
                registeredAt: d.registeredAt,
                lastConnectedAt: d.lastConnectedAt,
                revokedAt: d.revokedAt,
                revocationReason: d.revocationReason
            }));
            res.json({ total: devices.length, devices });
        });
        this.app.post('/admin/devices/:deviceId/revoke', this.authenticate('admin'), (req, res) => {
            const deviceId = req.params.deviceId;
            const reason = req.body?.reason || 'Admin action';
            this.authManager.revokeDevice(deviceId, reason);
            this.killSwitch.revokeDevice(deviceId, reason);
            this.connectionManager.disconnectDevice(deviceId, reason);
            res.json({ ok: true, deviceId, status: 'revoked' });
        });
        this.app.get('/admin/tasks', this.authenticate('admin'), (req, res) => {
            const isInventoryView = req.path.includes('/inventory') || req.query.view === 'inventory';
            const limit = req.query.limit ? Math.min(Math.max(1, parseInt(req.query.limit, 10) || 100), 5000) : (isInventoryView ? 1000 : 100);
            const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset, 10) || 0) : 0;
            const backendParam = req.query.backend;
            const statusParam = req.query.status;
            const allTasks = this.taskStore.listTasks();
            const filteredTasks = allTasks.filter(t => {
                if (backendParam && t.backend !== backendParam)
                    return false;
                if (statusParam === 'active') {
                    return task_1.ACTIVE_TASK_STATUSES.has(t.status);
                }
                if (statusParam && statusParam !== 'all' && t.status !== statusParam)
                    return false;
                return true;
            });
            const paginatedTasks = filteredTasks.slice(offset, offset + limit);
            const localTasks = allTasks.filter(t => t.backend === 'local');
            const activeLocal = localTasks.filter(t => task_1.ACTIVE_TASK_STATUSES.has(t.status));
            const targetedLocal = activeLocal.filter(t => !!t.targetDeviceId);
            const quarantinedLocal = activeLocal.filter(t => !t.targetDeviceId);
            const withPriorClaimant = quarantinedLocal.filter(t => !!(t.lease?.claimedBy || (t.attempts && t.attempts.find(a => a.claimedBy)?.claimedBy)));
            const byTargetDevice = {};
            for (const t of targetedLocal) {
                if (t.targetDeviceId)
                    byTargetDevice[t.targetDeviceId] = (byTargetDevice[t.targetDeviceId] || 0) + 1;
            }
            const byStatus = {};
            for (const t of activeLocal) {
                byStatus[t.status] = (byStatus[t.status] || 0) + 1;
            }
            res.json({
                ok: true,
                total: filteredTasks.length,
                offset,
                limit,
                hasMore: offset + limit < filteredTasks.length,
                summary: {
                    totalActiveLocal: activeLocal.length,
                    totalTargeted: targetedLocal.length,
                    totalQuarantined: quarantinedLocal.length,
                    totalWithPriorClaimant: withPriorClaimant.length,
                    byTargetDevice,
                    byStatus
                },
                tasks: paginatedTasks.map(t => {
                    const priorClaimant = t.lease?.claimedBy || (t.attempts && [...t.attempts].reverse().find(a => a.claimedBy)?.claimedBy);
                    return {
                        taskId: t.taskId,
                        backend: t.backend,
                        capability: t.capability,
                        status: t.status,
                        targetDeviceId: t.targetDeviceId || undefined,
                        priorClaimant: priorClaimant || undefined,
                        isQuarantined: t.backend === 'local' && !t.targetDeviceId,
                        lease: t.lease ? {
                            claimedBy: t.lease.claimedBy,
                            expiresAt: t.lease.leaseExpiresAt,
                            workerId: t.lease.workerId
                        } : undefined,
                        attemptCount: t.attempts ? t.attempts.length : 0,
                        attemptsSummary: (t.attempts || []).map(a => ({
                            attemptId: a.id,
                            claimedBy: a.claimedBy,
                            status: a.status,
                            startedAt: a.startedAt,
                            completedAt: a.completedAt
                        })),
                        createdAt: t.createdAt,
                        startedAt: t.startedAt,
                        completedAt: t.completedAt,
                        updatedAt: t.updatedAt
                    };
                })
            });
        });
        this.app.get('/admin/tasks/inventory', this.authenticate('admin'), (req, res) => {
            req.query.view = 'inventory';
            this.app._router.handle(req, res, () => { });
        });
        this.app.post('/admin/tasks/assign-legacy', this.authenticate('admin'), (req, res) => {
            const { targetDeviceId, taskIds } = req.body || {};
            if (!targetDeviceId || typeof targetDeviceId !== 'string') {
                return res.status(400).json({ ok: false, error: 'INVALID_REQUEST: targetDeviceId is required and must be a string' });
            }
            if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every(id => typeof id === 'string' && id.trim().length > 0)) {
                return res.status(400).json({ ok: false, error: 'INVALID_REQUEST: taskIds is required and must be a non-empty array of task IDs' });
            }
            const dev = this.authManager.getDevice(targetDeviceId);
            if (!dev || dev.status === 'revoked') {
                return res.status(400).json({ ok: false, error: `INVALID_DEVICE: targetDeviceId ${targetDeviceId} is not a valid registered active device` });
            }
            const result = this.taskStore.assignQuarantinedTasks(targetDeviceId, taskIds);
            this.auditLogger.log({
                actor: req.auth?.subjectId || 'admin',
                actorType: 'admin',
                action: 'ADMIN_ASSIGN_LEGACY_TASKS',
                resource: targetDeviceId,
                result: 'SUCCESS',
                details: {
                    targetDeviceId,
                    count: result.assigned,
                    taskIds: result.taskIds
                }
            });
            return res.json({ ok: true, assignedCount: result.assigned, assignedTaskIds: result.taskIds });
        });
        const handleRemoteMcp = async (req, res) => {
            const auth = req.auth;
            const body = req.body;
            const validation = (0, protocol_1.validateMcpRequest)(this.requestHeaders(req), body);
            if ('status' in validation)
                return res.status(validation.status).json(validation.body);
            const modern = validation.modern;
            if (modern)
                res.setHeader('MCP-Protocol-Version', validation.protocolVersion);
            const jsonrpc = body?.jsonrpc || '2.0';
            const id = body?.id !== undefined ? body.id : null;
            const method = body?.method;
            const caller = { scopes: auth.scopes, subjectId: auth.subjectId };
            const wrap = (value) => modern ? (0, protocol_1.modernResult)(value) : value;
            const wrapList = (value) => modern ? (0, protocol_1.modernCacheableResult)(value, { ttlMs: 0, cacheScope: 'private' }) : value;
            if (method === 'server/discover') {
                if (!modern)
                    return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: 'server/discover requires MCP 2026-07-28' } });
                return res.json({ jsonrpc, id, result: (0, protocol_1.modernCacheableResult)({ supportedVersions: [...protocol_1.MCP_SUPPORTED_MODERN_VERSIONS], capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'DevSpace Ultra vNext', version: '2.1.0' } }, tools: this.getToolsList() }, { ttlMs: 0, cacheScope: 'private' }) });
            }
            if (method === 'initialize') {
                if (modern)
                    return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: 'Use server/discover with MCP 2026-07-28' } });
                return res.json({ jsonrpc, id, result: { protocolVersion: validation.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DevSpace Ultra vNext', version: '2.1.0' }, tools: this.getToolsList() } });
            }
            if (method === 'ping')
                return res.json({ jsonrpc, id, result: wrap({}) });
            if (method === 'tools/list')
                return res.json({ jsonrpc, id, result: wrapList({ tools: this.getToolsList() }) });
            if (method === 'resources/list')
                return res.json({ jsonrpc, id, result: wrapList({ resources: [] }) });
            if (method === 'prompts/list')
                return res.json({ jsonrpc, id, result: wrapList({ prompts: [] }) });
            if (method === 'notifications/initialized' || method === 'initialized')
                return res.status(204).end();
            if (method === 'tools/call') {
                try {
                    const result = await this.callTool(body?.params?.name, body?.params?.arguments || {}, caller);
                    return res.json({ jsonrpc, id, result: wrap({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }) });
                }
                catch (err) {
                    if (err.mcpNotFound)
                        return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: err.message } });
                    return res.json({ jsonrpc, id, result: wrap({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] }) });
                }
            }
            return res.status(modern ? 404 : 400).json({ jsonrpc, id, error: { code: -32601, message: `Method '${method}' not found` } });
        };
        this.app.post('/mcp', this.authenticate(), handleRemoteMcp);
        this.app.post('/api/mcp/v1', this.authenticate(), handleRemoteMcp);
        this.app.post('/api/tasks', this.authenticate(), async (req, res) => {
            const auth = req.auth;
            const { backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey, targetDeviceId } = req.body;
            if (!backend || !capability || payload === undefined)
                return res.status(400).json({ error: 'INVALID_TASK_PAYLOAD' });
            try {
                const result = await this.taskRouter.routeTaskSubmit({ backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey, targetDeviceId }, auth.scopes, auth.subjectId);
                res.status(202).json({ taskId: result.taskId, status: result.status, backend, capability, isReplay: !!result.isReplay, createdAt: result.task.createdAt });
            }
            catch (err) {
                res.status(err.message?.includes('AUTH_FORBIDDEN') ? 403 : err.message?.includes('KILL_SWITCH') ? 503 : 500).json({ error: 'TASK_SUBMISSION_FAILED', message: err.message });
            }
        });
        this.app.get('/api/tasks/:taskId', this.authenticate('tasks:read'), (req, res) => {
            const task = this.taskStore.getTask(req.params.taskId);
            if (!task)
                return res.status(404).json({ error: 'TASK_NOT_FOUND' });
            res.json(task);
        });
        this.app.post('/api/tasks/:taskId/cancel', this.authenticate('tasks:cancel'), (req, res) => {
            const auth = req.auth;
            try {
                const result = this.taskRouter.cancelTask(req.params.taskId, req.body.reason || 'User requested', auth.scopes, auth.subjectId);
                res.json(result);
            }
            catch (err) {
                res.status(err.message?.includes('AUTH_FORBIDDEN') ? 403 : 400).json({ error: err.message });
            }
        });
        this.app.get('/api/tasks/:taskId/logs', this.authenticate('tasks:read'), (req, res) => {
            const task = this.taskStore.getTask(req.params.taskId);
            if (!task)
                return res.status(404).json({ error: 'TASK_NOT_FOUND' });
            const limit = parseInt(req.query.limit) || 1000;
            res.json({ taskId: task.taskId, logs: task.logs.slice(-limit) });
        });
        this.app.get('/api/tasks/:taskId/artifacts', this.authenticate('artifacts:read'), (req, res) => {
            const task = this.taskStore.getTask(req.params.taskId);
            if (!task)
                return res.status(404).json({ error: 'TASK_NOT_FOUND' });
            res.json({ taskId: task.taskId, artifacts: task.artifacts.map(id => this.artifactStore.getArtifactMetadata(id)).filter(Boolean) });
        });
        this.app.get('/api/artifacts/:artifactId', this.authenticate('artifacts:read'), (req, res) => {
            const meta = this.artifactStore.getArtifactMetadata(req.params.artifactId);
            if (!meta)
                return res.status(404).json({ error: 'ARTIFACT_NOT_FOUND' });
            const content = this.artifactStore.getArtifactContent(req.params.artifactId);
            if (content === undefined)
                return res.status(404).json({ error: 'ARTIFACT_PAYLOAD_UNAVAILABLE' });
            res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${meta.name.replace(/"/g, '')}"`);
            res.send(content);
        });
    }
    setupWebSocket() {
        this.wss.on('connection', ws => {
            this.connectionManager.handleConnection(ws);
        });
    }
    async start() {
        const port = this.config.port ?? 4000;
        const host = this.config.host || '0.0.0.0';
        this.leaseMonitor.start();
        // Only migrate tasks with verifiable prior claimant. Unassigned tasks remain quarantined.
        this.taskStore.migrateLegacyUnassignedTasks();
        return new Promise((resolve, reject) => {
            const onError = (error) => {
                this.httpServer.off('listening', onListening);
                reject(error);
            };
            const onListening = () => {
                this.httpServer.off('error', onError);
                resolve();
            };
            this.httpServer.once('error', onError);
            this.httpServer.once('listening', onListening);
            this.httpServer.listen(port, host);
        });
    }
    async stop() {
        this.leaseMonitor.stop();
        this.wss.close();
        if (!this.httpServer.listening)
            return;
        return new Promise(resolve => this.httpServer.close(() => resolve()));
    }
}
exports.GatewayServer = GatewayServer;
