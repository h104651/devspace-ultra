import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { AuthManager } from '../security/auth-manager';
import { ScopeChecker } from '../security/scope-checker';
import { KillSwitch } from '../security/kill-switch';
import { RateLimiter } from '../security/rate-limiter';
import { AuditLogger } from '../security/audit-logger';
import { TaskStore } from '../storage/task-store';
import { ArtifactStore } from '../storage/artifact-store';
import { IdempotencyStore } from '../storage/idempotency-store';
import { KaggleBackend } from '../kaggle/backend';
import { SwarmOrchestrator } from '../swarm/swarm-orchestrator';
import { ConnectionManager } from './connection-manager';
import { LeaseMonitor } from './lease-monitor';
import { TaskRouter } from './task-router';
import { McpHandlers, McpCallerContext } from '../mcp/handlers';
import * as tools from '../mcp/tools';
import { REMOTE_TASK_WAIT_TOOL, handleRemoteTaskWait } from '../mcp/reliability-tools';
import { TokenPayload } from '../types/auth';
import { ACTIVE_TASK_STATUSES } from '../types/task';
import { modernCacheableResult, modernResult, validateMcpRequest, MCP_SUPPORTED_MODERN_VERSIONS } from '../mcp/protocol';

export interface GatewayServerConfig {
  port?: number;
  host?: string;
  storageDir?: string;
  masterSecret?: string;
  kaggleMockMode?: boolean;
  kagglePollIntervalMs?: number;
}

export class GatewayServer {
  public app: express.Application;
  public httpServer: http.Server;
  public wss: WebSocketServer;
  public authManager: AuthManager;
  public killSwitch: KillSwitch;
  public rateLimiter: RateLimiter;
  public auditLogger: AuditLogger;
  public taskStore: TaskStore;
  public artifactStore: ArtifactStore;
  public idempotencyStore: IdempotencyStore;
  public kaggleBackend: KaggleBackend;
  public swarmOrchestrator: SwarmOrchestrator;
  public connectionManager: ConnectionManager;
  public leaseMonitor: LeaseMonitor;
  public taskRouter: TaskRouter;
  public mcpHandlers: McpHandlers;
  private config: GatewayServerConfig;

  constructor(config: GatewayServerConfig = {}) {
    this.config = config;
    const storageDir = config.storageDir || '.devspace-storage';
    this.authManager = new AuthManager(config.masterSecret, storageDir);
    this.killSwitch = new KillSwitch(storageDir);
    this.rateLimiter = new RateLimiter();
    this.auditLogger = new AuditLogger(storageDir);
    this.taskStore = new TaskStore(storageDir);
    this.artifactStore = new ArtifactStore(storageDir);
    this.idempotencyStore = new IdempotencyStore(storageDir);
    this.kaggleBackend = new KaggleBackend(this.taskStore, this.artifactStore, undefined, storageDir, config.kagglePollIntervalMs || 15000);
    if (config.kaggleMockMode) this.kaggleBackend.getClient().setMockMode(true);
    this.swarmOrchestrator = new SwarmOrchestrator(this.taskStore);
    this.connectionManager = new ConnectionManager(this.authManager, this.killSwitch, this.auditLogger, this.taskStore);
    this.leaseMonitor = new LeaseMonitor(this.taskStore, this.connectionManager, this.auditLogger);
    this.taskRouter = new TaskRouter(
      this.taskStore,
      this.idempotencyStore,
      this.kaggleBackend,
      this.swarmOrchestrator,
      this.killSwitch,
      this.auditLogger,
      this.connectionManager,
      this.authManager
    );
    this.mcpHandlers = new McpHandlers(this);
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws/agent' });
    this.setupMiddlewares();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddlewares() {
    this.app.use(cors({ exposedHeaders: ['MCP-Protocol-Version', 'WWW-Authenticate'] }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rl = this.rateLimiter.isAllowed(ip);
      if (!rl.allowed) return res.status(429).json({ error: 'RATE_LIMITED', retryAfterMs: rl.retryAfterMs });
      next();
    });
  }

  private authenticate(requiredScope?: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Authorization header with Bearer token is required' });
      const validation = this.authManager.validateToken(authHeader.substring(7));
      if (!validation.valid || !validation.payload) return res.status(401).json({ error: 'AUTH_INVALID', message: validation.error || 'Token invalid or expired' });
      if (validation.payload.metadata?.purpose === 'refresh_token') return res.status(401).json({ error: 'AUTH_INVALID', message: 'Refresh tokens cannot be used as access tokens' });
      if (this.killSwitch.isClientRevoked(validation.payload.subjectId)) return res.status(403).json({ error: 'CLIENT_REVOKED' });
      if (requiredScope && !ScopeChecker.hasScope(validation.payload.scopes, requiredScope)) return res.status(403).json({ error: 'AUTH_FORBIDDEN', message: `Required scope '${requiredScope}' not granted` });
      (req as any).auth = validation.payload;
      next();
    };
  }

  private requestHeaders(req: Request): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, String(value));
    }
    return headers;
  }

  private getToolsList() {
    return [...tools.getCanonicalToolsList(), REMOTE_TASK_WAIT_TOOL];
  }

  private async callTool(name: string, args: any, caller: McpCallerContext): Promise<any> {
    switch (name) {
      case 'remote_task_submit': return this.mcpHandlers.handleRemoteTaskSubmit(args, caller);
      case 'remote_task_status': return this.mcpHandlers.handleRemoteTaskStatus(args, caller);
      case 'task_inventory': return this.mcpHandlers.handleTaskInventory(args, caller);
      case 'remote_task_wait': return handleRemoteTaskWait(this.taskStore, args, caller.scopes);
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
      case 'device_drain': return this.mcpHandlers.handleDeviceAdmissionChange(args, caller, true);
      case 'device_resume': return this.mcpHandlers.handleDeviceAdmissionChange(args, caller, false);
      case 'kill_switch_trigger': return this.mcpHandlers.handleKillSwitchTrigger(args, caller);
      default: throw Object.assign(new Error(`Tool '${name}' not found`), { mcpNotFound: true });
    }
  }

  private setupRoutes() {
    this.app.get('/health', (_req, res) => res.json({ ok: true }));
    this.app.get('/admin/health', this.authenticate('admin:health'), (_req, res) => res.json({ status: 'healthy', service: 'devspace-ultra-gateway', version: '2.1.0', timestamp: Date.now(), connectedAgents: this.connectionManager.getConnectedAgents().length }));

    this.app.post('/admin/devices', this.authenticate('admin'), async (req: Request, res: Response) => {
      try {
        const { name, platform, capabilities, deviceId, expiresInMs } = req.body || {};
        if (!name || typeof name !== 'string') {
          return res.status(400).json({ error: 'INVALID_ARGUMENT: name is required' });
        }
        const reg = this.authManager.registerDevice(name, platform || 'windows', capabilities, deviceId, expiresInMs);
        await this.killSwitch.unrevokeDevice(reg.deviceId);
        this.auditLogger.log({ actor: (req as any).auth?.subjectId || 'admin', actorType: 'client', action: 'DEVICE_REGISTERED', resource: reg.deviceId, result: 'SUCCESS' });
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
      } catch (err: any) {
        const isConflict = err.message?.includes('DEVICE_ID_CONFLICT');
        return res.status(isConflict ? 409 : 400).json({ error: err.message });
      }
    });

    this.app.get('/admin/devices', this.authenticate('admin'), (_req: Request, res: Response) => {
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

    this.app.post('/admin/devices/:deviceId/revoke', this.authenticate('admin'), (req: Request, res: Response) => {
      const deviceId = req.params.deviceId;
      const reason = req.body?.reason || 'Admin action';
      this.authManager.revokeDevice(deviceId, reason);
      this.killSwitch.revokeDevice(deviceId, reason);
      this.connectionManager.disconnectDevice(deviceId, reason);
      res.json({ ok: true, deviceId, status: 'revoked' });
    });

    this.app.get('/admin/tasks', this.authenticate('admin'), (req: Request, res: Response) => {
      const isInventoryView = req.path.includes('/inventory') || req.query.view === 'inventory';
      const limit = req.query.limit ? Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 100), 5000) : (isInventoryView ? 1000 : 100);
      const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset as string, 10) || 0) : 0;
      const backendParam = req.query.backend as string | undefined;
      const statusParam = req.query.status as string | undefined;

      const allTasks = this.taskStore.listTasks();
      const filteredTasks = allTasks.filter(t => {
        if (backendParam && t.backend !== backendParam) return false;
        if (statusParam === 'active') {
          return ACTIVE_TASK_STATUSES.has(t.status);
        }
        if (statusParam && statusParam !== 'all' && t.status !== statusParam) return false;
        return true;
      });

      const paginatedTasks = filteredTasks.slice(offset, offset + limit);
      const localTasks = allTasks.filter(t => t.backend === 'local');
      const activeLocal = localTasks.filter(t => ACTIVE_TASK_STATUSES.has(t.status));
      const targetedLocal = activeLocal.filter(t => !!t.targetDeviceId);
      const quarantinedLocal = activeLocal.filter(t => !t.targetDeviceId);
      const withPriorClaimant = quarantinedLocal.filter(t => !!(t.lease?.claimedBy || (t.attempts && t.attempts.find(a => a.claimedBy)?.claimedBy)));

      const byTargetDevice: Record<string, number> = {};
      for (const t of targetedLocal) {
        if (t.targetDeviceId) byTargetDevice[t.targetDeviceId] = (byTargetDevice[t.targetDeviceId] || 0) + 1;
      }
      const byStatus: Record<string, number> = {};
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
              workerId: (t.lease as any).workerId
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

    this.app.get('/admin/tasks/inventory', this.authenticate('admin'), (req: Request, res: Response) => {
      (req.query as any).view = 'inventory';
      (this.app as any)._router.handle(req, res, () => {});
    });

    this.app.post('/admin/tasks/assign-legacy', this.authenticate('admin'), (req: Request, res: Response) => {
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
        actor: (req as any).auth?.subjectId || 'admin',
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

    const handleRemoteMcp = async (req: Request, res: Response) => {
      const auth: TokenPayload = (req as any).auth;
      const body = req.body;
      const validation = validateMcpRequest(this.requestHeaders(req), body);
      if ('status' in validation) return res.status(validation.status).json(validation.body);
      const modern = validation.modern;
      if (modern) res.setHeader('MCP-Protocol-Version', validation.protocolVersion);
      const jsonrpc = body?.jsonrpc || '2.0';
      const id = body?.id !== undefined ? body.id : null;
      const method = body?.method;
      const caller = { scopes: auth.scopes, subjectId: auth.subjectId };
      const wrap = (value: any) => modern ? modernResult(value) : value;
      const wrapList = (value: any) => modern ? modernCacheableResult(value, { ttlMs: 0, cacheScope: 'private' }) : value;

      if (method === 'server/discover') {
        if (!modern) return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: 'server/discover requires MCP 2026-07-28' } });
        return res.json({ jsonrpc, id, result: modernCacheableResult({ supportedVersions: [...MCP_SUPPORTED_MODERN_VERSIONS], capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'DevSpace Ultra vNext', version: '2.1.0' } }, tools: this.getToolsList() }, { ttlMs: 0, cacheScope: 'private' }) });
      }
      if (method === 'initialize') {
        if (modern) return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: 'Use server/discover with MCP 2026-07-28' } });
        return res.json({ jsonrpc, id, result: { protocolVersion: validation.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DevSpace Ultra vNext', version: '2.1.0' }, tools: this.getToolsList() } });
      }
      if (method === 'ping') return res.json({ jsonrpc, id, result: wrap({}) });
      if (method === 'tools/list') return res.json({ jsonrpc, id, result: wrapList({ tools: this.getToolsList() }) });
      if (method === 'resources/list') return res.json({ jsonrpc, id, result: wrapList({ resources: [] }) });
      if (method === 'prompts/list') return res.json({ jsonrpc, id, result: wrapList({ prompts: [] }) });
      if (method === 'notifications/initialized' || method === 'initialized') return res.status(204).end();
      if (method === 'tools/call') {
        try {
          const result = await this.callTool(body?.params?.name, body?.params?.arguments || {}, caller);
          return res.json({ jsonrpc, id, result: wrap({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }) });
        } catch (err: any) {
          if (err.mcpNotFound) return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: err.message } });
          return res.json({ jsonrpc, id, result: wrap({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] }) });
        }
      }
      return res.status(modern ? 404 : 400).json({ jsonrpc, id, error: { code: -32601, message: `Method '${method}' not found` } });
    };

    this.app.post('/mcp', this.authenticate(), handleRemoteMcp);
    this.app.post('/api/mcp/v1', this.authenticate(), handleRemoteMcp);

    this.app.post('/api/tasks', this.authenticate(), async (req: Request, res: Response) => {
      const auth: TokenPayload = (req as any).auth;
      const { backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey, targetDeviceId } = req.body;
      if (!backend || !capability || payload === undefined) return res.status(400).json({ error: 'INVALID_TASK_PAYLOAD' });
      try {
        const result = await this.taskRouter.routeTaskSubmit({ backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey, targetDeviceId }, auth.scopes, auth.subjectId);
        res.status(202).json({ taskId: result.taskId, status: result.status, backend, capability, isReplay: !!result.isReplay, createdAt: result.task.createdAt });
      } catch (err: any) {
        res.status(err.message?.includes('AUTH_FORBIDDEN') ? 403 : err.message?.includes('KILL_SWITCH') ? 503 : 500).json({ error: 'TASK_SUBMISSION_FAILED', message: err.message });
      }
    });

    this.app.get('/api/tasks/:taskId', this.authenticate('tasks:read'), (req, res) => {
      const task = this.taskStore.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
      res.json(task);
    });

    this.app.post('/api/tasks/:taskId/cancel', this.authenticate('tasks:cancel'), (req, res) => {
      const auth: TokenPayload = (req as any).auth;
      try {
        const result = this.taskRouter.cancelTask(req.params.taskId, req.body.reason || 'User requested', auth.scopes, auth.subjectId);
        res.json(result);
      } catch (err: any) {
        res.status(err.message?.includes('AUTH_FORBIDDEN') ? 403 : 400).json({ error: err.message });
      }
    });

    this.app.get('/api/tasks/:taskId/logs', this.authenticate('tasks:read'), (req, res) => {
      const task = this.taskStore.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
      const limit = parseInt(req.query.limit as string) || 1000;
      res.json({ taskId: task.taskId, logs: task.logs.slice(-limit) });
    });

    this.app.get('/api/tasks/:taskId/artifacts', this.authenticate('artifacts:read'), (req, res) => {
      const task = this.taskStore.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
      res.json({ taskId: task.taskId, artifacts: task.artifacts.map(id => this.artifactStore.getArtifactMetadata(id)).filter(Boolean) });
    });

    this.app.get('/api/artifacts/:artifactId', this.authenticate('artifacts:read'), (req, res) => {
      const meta = this.artifactStore.getArtifactMetadata(req.params.artifactId);
      if (!meta) return res.status(404).json({ error: 'ARTIFACT_NOT_FOUND' });
      const content = this.artifactStore.getArtifactContent(req.params.artifactId);
      if (content === undefined) return res.status(404).json({ error: 'ARTIFACT_PAYLOAD_UNAVAILABLE' });
      res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${meta.name.replace(/"/g, '')}"`);
      res.send(content);
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', ws => {
      this.connectionManager.handleConnection(ws);
    });
  }

  public async start(): Promise<void> {
    const port = this.config.port ?? 4000;
    const host = this.config.host || '0.0.0.0';
    this.leaseMonitor.start();
    // Only migrate tasks with verifiable prior claimant. Unassigned tasks remain quarantined.
    this.taskStore.migrateLegacyUnassignedTasks();
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
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

  public async stop(): Promise<void> {
    this.leaseMonitor.stop();
    this.wss.close();
    if (!this.httpServer.listening) return;
    return new Promise(resolve => this.httpServer.close(() => resolve()));
  }
}