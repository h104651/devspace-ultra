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
import { TokenPayload } from '../types/auth';
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
    this.taskRouter = new TaskRouter(this.taskStore, this.idempotencyStore, this.kaggleBackend, this.swarmOrchestrator, this.killSwitch, this.auditLogger);
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
    return [
      { name: 'remote_task_submit', description: 'Submit durable task to supported backends', inputSchema: tools.REMOTE_TASK_SUBMIT_SCHEMA },
      { name: 'remote_task_status', description: 'Query durable task status', inputSchema: tools.REMOTE_TASK_STATUS_SCHEMA },
      { name: 'remote_task_logs', description: 'Fetch task logs', inputSchema: tools.REMOTE_TASK_LOGS_SCHEMA },
      { name: 'remote_task_artifacts', description: 'List task artifacts', inputSchema: tools.REMOTE_TASK_ARTIFACTS_SCHEMA },
      { name: 'remote_task_cancel', description: 'Cancel a task', inputSchema: tools.REMOTE_TASK_CANCEL_SCHEMA },
      { name: 'kaggle_run', description: 'Run code on Kaggle', inputSchema: tools.KAGGLE_RUN_SCHEMA },
      { name: 'kaggle_status', description: 'Check Kaggle task', inputSchema: tools.KAGGLE_STATUS_SCHEMA },
      { name: 'kaggle_logs', description: 'Fetch Kaggle logs', inputSchema: tools.KAGGLE_LOGS_SCHEMA },
      { name: 'kaggle_result', description: 'Fetch Kaggle result', inputSchema: tools.KAGGLE_RESULT_SCHEMA },
      { name: 'swarm_dispatch', description: 'Dispatch swarm task', inputSchema: tools.SWARM_DISPATCH_SCHEMA },
      { name: 'swarm_status', description: 'Check swarm status', inputSchema: tools.SWARM_STATUS_SCHEMA },
      { name: 'chat_swarm_dispatch', description: 'Dispatch Chat Swarm task', inputSchema: tools.CHAT_SWARM_DISPATCH_SCHEMA },
      { name: 'chat_swarm_status', description: 'Check Chat Swarm status', inputSchema: tools.CHAT_SWARM_STATUS_SCHEMA },
      { name: 'chat_swarm_claim', description: 'Register and claim vNext swarm worker work', inputSchema: tools.CHAT_SWARM_CLAIM_SCHEMA },
      { name: 'chat_swarm_next', description: 'Claim next worker task', inputSchema: tools.CHAT_SWARM_NEXT_SCHEMA },
      { name: 'chat_swarm_submit', description: 'Submit worker result', inputSchema: tools.CHAT_SWARM_SUBMIT_SCHEMA },
      { name: 'chat_swarm_cancel', description: 'Cancel swarm task', inputSchema: tools.CHAT_SWARM_CANCEL_SCHEMA },
      { name: 'chat_swarm_wake_bridge', description: 'Check wake bridge', inputSchema: tools.CHAT_SWARM_WAKE_BRIDGE_SCHEMA },
      { name: 'chat_swarm_runtime_status', description: 'Check runtime workers', inputSchema: tools.CHAT_SWARM_RUNTIME_STATUS_SCHEMA },
      { name: 'device_status', description: 'Inspect local agent devices', inputSchema: tools.DEVICE_STATUS_SCHEMA },
      { name: 'kill_switch_trigger', description: 'Administrative kill switch', inputSchema: tools.KILL_SWITCH_TRIGGER_SCHEMA }
    ];
  }

  private async callTool(name: string, args: any, caller: McpCallerContext): Promise<any> {
    switch (name) {
      case 'remote_task_submit': return this.mcpHandlers.handleRemoteTaskSubmit(args, caller);
      case 'remote_task_status': return this.mcpHandlers.handleRemoteTaskStatus(args, caller);
      case 'remote_task_logs': return this.mcpHandlers.handleRemoteTaskLogs(args, caller);
      case 'remote_task_artifacts': return this.mcpHandlers.handleRemoteTaskArtifacts(args, caller);
      case 'remote_task_cancel': return this.mcpHandlers.handleRemoteTaskCancel(args, caller);
      case 'kaggle_run': return this.mcpHandlers.handleKaggleRun(args, caller);
      case 'kaggle_status': return this.mcpHandlers.handleKaggleStatus(args, caller);
      case 'kaggle_logs': return this.mcpHandlers.handleKaggleLogs(args, caller);
      case 'kaggle_result': return this.mcpHandlers.handleKaggleResult(args, caller);
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
      case 'device_status': return this.mcpHandlers.handleDeviceStatus(caller);
      case 'kill_switch_trigger': return this.mcpHandlers.handleKillSwitchTrigger(args, caller);
      default: throw Object.assign(new Error(`Tool '${name}' not found`), { mcpNotFound: true });
    }
  }

  private setupRoutes() {
    this.app.get('/health', (_req, res) => res.json({ ok: true }));
    this.app.get('/admin/health', this.authenticate('admin:health'), (_req, res) => res.json({ status: 'healthy', service: 'devspace-ultra-gateway', version: '2.0.1', timestamp: Date.now(), connectedAgents: this.connectionManager.getConnectedAgents().length }));

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
      const wrapList = (value: any) => modern ? modernCacheableResult(value, { ttlMs: 300000, cacheScope: 'private' }) : value;

      if (method === 'server/discover') {
        if (!modern) return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: 'server/discover requires MCP 2026-07-28' } });
        return res.json({ jsonrpc, id, result: modernCacheableResult({ supportedVersions: [...MCP_SUPPORTED_MODERN_VERSIONS], capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'DevSpace Ultra vNext', version: '2.0.1' } } }, { ttlMs: 300000, cacheScope: 'private' }) });
      }
      if (method === 'initialize') {
        if (modern) return res.status(404).json({ jsonrpc, id, error: { code: -32601, message: 'Use server/discover with MCP 2026-07-28' } });
        return res.json({ jsonrpc, id, result: { protocolVersion: validation.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DevSpace Ultra vNext', version: '2.0.1' } } });
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
      const { backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey } = req.body;
      if (!backend || !capability || payload === undefined) return res.status(400).json({ error: 'INVALID_TASK_PAYLOAD' });
      try {
        const result = await this.taskRouter.routeTaskSubmit({ backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey }, auth.scopes, auth.subjectId);
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
    this.app.get('/api/tasks/:taskId/logs', this.authenticate('tasks:read'), (req, res) => {
      const task = this.taskStore.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'TASK_NOT_FOUND' });
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ taskId: task.taskId, totalLines: task.logs.length, lines: task.logs.slice(-limit) });
    });
    this.app.get('/api/tasks/:taskId/artifacts', this.authenticate('artifacts:read'), (req, res) => res.json({ taskId: req.params.taskId, artifacts: this.artifactStore.getTaskArtifacts(req.params.taskId) }));
    this.app.get('/api/artifacts/:artifactId', this.authenticate('artifacts:read'), (req, res) => {
      const meta = this.artifactStore.getArtifactMetadata(req.params.artifactId);
      if (!meta) return res.status(404).json({ error: 'ARTIFACT_NOT_FOUND' });
      const content = this.artifactStore.readArtifactContent(req.params.artifactId);
      if (!content) return res.status(404).json({ error: 'ARTIFACT_CONTENT_NOT_FOUND' });
      res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${meta.name.replace(/"/g, '')}"`);
      res.send(content);
    });
    this.app.post('/api/tasks/:taskId/cancel', this.authenticate('tasks:submit'), (req, res) => {
      const success = this.taskStore.cancelTask(req.params.taskId, req.body.reason || 'Cancelled via API');
      return success ? res.json({ taskId: req.params.taskId, status: 'cancelled' }) : res.status(400).json({ error: 'TASK_CANCEL_FAILED' });
    });
    this.app.get('/api/devices', this.authenticate('admin:*'), (_req, res) => res.json({ devices: this.authManager.listDevices(), connected: this.connectionManager.getConnectedAgents() }));
    this.app.post('/api/kill-switch', this.authenticate('admin:killswitch'), (req, res) => {
      const { action, reason, deviceId, clientId } = req.body;
      if (action === 'EMERGENCY_STOP') this.killSwitch.triggerGlobalEmergencyStop(reason);
      else if (action === 'CLEAR_STOP') this.killSwitch.resetGlobalEmergencyStop();
      else if (action === 'REVOKE_DEVICE' && deviceId) { this.killSwitch.revokeDevice(deviceId, reason); this.authManager.revokeDevice(deviceId, reason); }
      else if (action === 'REVOKE_CLIENT' && clientId) this.killSwitch.revokeClient(clientId, reason);
      res.json({ status: 'OK', killSwitchState: this.killSwitch.getState() });
    });
    this.app.get('/api/audit', this.authenticate('admin:*'), (req, res) => res.json({ logs: this.auditLogger.getRecentLogs(parseInt(req.query.limit as string) || 100) }));
  }

  private setupWebSocket() {
    this.wss.on('connection', (socket: any, req: any) => this.connectionManager.handleConnection(socket, req.socket.remoteAddress || 'unknown'));
  }

  public async start(): Promise<void> {
    const port = this.config.port || 4000;
    const host = this.config.host || '0.0.0.0';
    this.leaseMonitor.start();
    return new Promise(resolve => this.httpServer.listen(port, host, resolve));
  }

  public async stop(): Promise<void> {
    this.leaseMonitor.stop();
    this.wss.close();
    return new Promise(resolve => this.httpServer.close(() => resolve()));
  }
}
