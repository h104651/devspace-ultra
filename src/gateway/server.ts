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
import { McpHandlers } from '../mcp/handlers';
import * as tools from '../mcp/tools';
import { TokenPayload } from '../types/auth';

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

    this.kaggleBackend = new KaggleBackend(
      this.taskStore,
      this.artifactStore,
      undefined,
      storageDir,
      config.kagglePollIntervalMs || 15000
    );
    if (config.kaggleMockMode) {
      this.kaggleBackend.getClient().setMockMode(true);
    }

    this.swarmOrchestrator = new SwarmOrchestrator(this.taskStore);
    this.connectionManager = new ConnectionManager(this.authManager, this.killSwitch, this.auditLogger, this.taskStore);
    this.leaseMonitor = new LeaseMonitor(this.taskStore, this.connectionManager, this.auditLogger);

    this.taskRouter = new TaskRouter(
      this.taskStore,
      this.idempotencyStore,
      this.kaggleBackend,
      this.swarmOrchestrator,
      this.killSwitch,
      this.auditLogger
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
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));

    // Rate limiter middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const rl = this.rateLimiter.isAllowed(ip);
      if (!rl.allowed) {
        return res.status(429).json({
          error: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down.',
          retryAfterMs: rl.retryAfterMs
        });
      }
      next();
    });
  }

  private authenticate(requiredScope?: string) {
    return (req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'AUTH_REQUIRED',
          message: 'Authorization header with Bearer token is required'
        });
      }

      const token = authHeader.substring(7);
      const validation = this.authManager.validateToken(token);
      if (!validation.valid || !validation.payload) {
        return res.status(401).json({
          error: 'AUTH_INVALID',
          message: validation.error || 'Token invalid or expired'
        });
      }

      if (this.killSwitch.isClientRevoked(validation.payload.subjectId)) {
        return res.status(403).json({
          error: 'CLIENT_REVOKED',
          message: 'Client access has been revoked'
        });
      }

      if (requiredScope && !ScopeChecker.hasScope(validation.payload.scopes, requiredScope)) {
        return res.status(403).json({
          error: 'AUTH_FORBIDDEN',
          message: `Required scope '${requiredScope}' not granted`
        });
      }

      (req as any).auth = validation.payload;
      next();
    };
  }

  private setupRoutes() {
    // Public Minimal Health check (Unauthenticated liveness only)
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ ok: true });
    });

    // Detailed Admin Health check (Requires admin:* or admin:health or admin:killswitch)
    this.app.get('/admin/health', this.authenticate(), (req: Request, res: Response) => {
      const auth: TokenPayload = (req as any).auth;
      if (!ScopeChecker.hasScope(auth.scopes, 'admin:health') &&
          !ScopeChecker.hasScope(auth.scopes, 'admin:*') &&
          !ScopeChecker.hasScope(auth.scopes, 'admin:killswitch')) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'admin scope required' });
      }

      res.json({
        status: 'healthy',
        service: 'devspace-ultra-gateway',
        version: '2.0.0',
        timestamp: Date.now(),
        connectedAgents: this.connectionManager.getConnectedAgents().length,
        killSwitch: this.killSwitch.getState().globalEmergencyStop ? 'EMERGENCY_STOP' : 'ACTIVE'
      });
    });

    // Remote MCP Protocol Endpoint (POST /mcp or POST /api/mcp/v1)
    const handleRemoteMcp = async (req: Request, res: Response) => {
      const auth: TokenPayload = (req as any).auth;
      const { method, params, id, jsonrpc } = req.body;

      if (method === 'tools/list') {
        return res.json({
          jsonrpc: jsonrpc || '2.0',
          id: id ?? 1,
          result: {
            tools: [
              {
                name: 'remote_task_submit',
                description: 'Submit a durable task to execute across backends (kaggle, local Windows agent, swarm, browser)',
                inputSchema: tools.REMOTE_TASK_SUBMIT_SCHEMA
              },
              {
                name: 'remote_task_status',
                description: 'Query status, lifecycle state, execution result, and error of a durable task by taskId',
                inputSchema: tools.REMOTE_TASK_STATUS_SCHEMA
              },
              {
                name: 'remote_task_logs',
                description: 'Fetch real-time streaming execution logs for a task',
                inputSchema: tools.REMOTE_TASK_LOGS_SCHEMA
              },
              {
                name: 'remote_task_artifacts',
                description: 'List generated output artifacts, files, and previews for a task',
                inputSchema: tools.REMOTE_TASK_ARTIFACTS_SCHEMA
              },
              {
                name: 'remote_task_cancel',
                description: 'Cancel an active or queued task',
                inputSchema: tools.REMOTE_TASK_CANCEL_SCHEMA
              },
              {
                name: 'kaggle_run',
                description: 'Run Python script or Jupyter Notebook on remote Free Kaggle GPU backend (asynchronous and durable)',
                inputSchema: tools.KAGGLE_RUN_SCHEMA
              },
              {
                name: 'kaggle_status',
                description: 'Check status of a Kaggle GPU execution job',
                inputSchema: tools.KAGGLE_STATUS_SCHEMA
              },
              {
                name: 'kaggle_logs',
                description: 'Fetch stdout/stderr logs from a running or completed Kaggle job',
                inputSchema: tools.KAGGLE_LOGS_SCHEMA
              },
              {
                name: 'kaggle_result',
                description: 'Retrieve final metrics, output files, and artifacts from a completed Kaggle job',
                inputSchema: tools.KAGGLE_RESULT_SCHEMA
              },
              {
                name: 'swarm_dispatch',
                description: 'Dispatch a prompt instruction task to Chat Swarm worker with automated claim and ack',
                inputSchema: tools.SWARM_DISPATCH_SCHEMA
              },
              {
                name: 'swarm_status',
                description: 'List active Chat Swarm workers, current task allocations, and wake bridge status',
                inputSchema: tools.SWARM_STATUS_SCHEMA
              }
            ]
          }
        });
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        try {
          let toolResult: any;
          switch (toolName) {
            case 'remote_task_submit':
              toolResult = await this.mcpHandlers.handleRemoteTaskSubmit(toolArgs);
              break;
            case 'remote_task_status':
              toolResult = await this.mcpHandlers.handleRemoteTaskStatus(toolArgs);
              break;
            case 'remote_task_logs':
              toolResult = await this.mcpHandlers.handleRemoteTaskLogs(toolArgs);
              break;
            case 'remote_task_artifacts':
              toolResult = await this.mcpHandlers.handleRemoteTaskArtifacts(toolArgs);
              break;
            case 'remote_task_cancel':
              toolResult = await this.mcpHandlers.handleRemoteTaskCancel(toolArgs);
              break;
            case 'kaggle_run':
              toolResult = await this.mcpHandlers.handleKaggleRun(toolArgs);
              break;
            case 'kaggle_status':
              toolResult = await this.mcpHandlers.handleKaggleStatus(toolArgs);
              break;
            case 'kaggle_logs':
              toolResult = await this.mcpHandlers.handleKaggleLogs(toolArgs);
              break;
            case 'kaggle_result':
              toolResult = await this.mcpHandlers.handleKaggleResult(toolArgs);
              break;
            case 'swarm_dispatch':
              toolResult = await this.mcpHandlers.handleSwarmDispatch(toolArgs);
              break;
            case 'swarm_status':
              toolResult = await this.mcpHandlers.handleSwarmStatus();
              break;
            default:
              return res.status(400).json({
                jsonrpc: jsonrpc || '2.0',
                id: id ?? 1,
                error: { code: -32601, message: `Method or tool '${toolName}' not found` }
              });
          }

          return res.json({
            jsonrpc: jsonrpc || '2.0',
            id: id ?? 1,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(toolResult, null, 2)
                }
              ]
            }
          });
        } catch (err: any) {
          return res.json({
            jsonrpc: jsonrpc || '2.0',
            id: id ?? 1,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: err.code || 'TOOL_ERROR',
                    message: err.message
                  }, null, 2)
                }
              ]
            }
          });
        }
      }

      res.status(400).json({
        jsonrpc: jsonrpc || '2.0',
        id: id ?? 1,
        error: { code: -32600, message: 'Invalid MCP Request' }
      });
    };

    this.app.post('/mcp', this.authenticate(), handleRemoteMcp);
    this.app.post('/api/mcp/v1', this.authenticate(), handleRemoteMcp);

    // Task Submit (REST)
    this.app.post('/api/tasks', this.authenticate(), async (req: Request, res: Response) => {
      const auth: TokenPayload = (req as any).auth;
      const { backend, capability, payload, priority, idempotencyKey, clientRequestId, taskKey } = req.body;

      if (!backend || !capability || !payload) {
        return res.status(400).json({
          error: 'INVALID_TASK_PAYLOAD',
          message: 'backend, capability, and payload fields are required'
        });
      }

      try {
        const result = await this.taskRouter.routeTaskSubmit(
          {
            backend,
            capability,
            payload,
            priority,
            idempotencyKey,
            clientRequestId,
            taskKey
          },
          auth.scopes,
          auth.subjectId
        );

        res.status(202).json({
          taskId: result.taskId,
          status: result.status,
          backend,
          capability,
          isReplay: !!result.isReplay,
          createdAt: result.task.createdAt
        });
      } catch (err: any) {
        const status = err.message?.includes('AUTH_FORBIDDEN') ? 403 : err.message?.includes('KILL_SWITCH') ? 503 : 500;
        res.status(status).json({
          error: 'TASK_SUBMISSION_FAILED',
          message: err.message
        });
      }
    });

    // Task Status
    this.app.get('/api/tasks/:taskId', this.authenticate(), (req: Request, res: Response) => {
      const { taskId } = req.params;
      const task = this.taskStore.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'TASK_NOT_FOUND', message: `Task ${taskId} not found` });
      }

      res.json({
        taskId: task.taskId,
        backend: task.backend,
        capability: task.capability,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        result: task.result,
        error: task.error,
        artifactsCount: task.artifacts.length,
        logsCount: task.logs.length
      });
    });

    // Task Logs
    this.app.get('/api/tasks/:taskId/logs', this.authenticate(), (req: Request, res: Response) => {
      const { taskId } = req.params;
      const task = this.taskStore.getTask(taskId);
      if (!task) {
        return res.status(404).json({ error: 'TASK_NOT_FOUND', message: `Task ${taskId} not found` });
      }

      const limit = parseInt(req.query.limit as string) || 100;
      const lines = task.logs.slice(-limit);
      res.json({ taskId, totalLines: task.logs.length, lines });
    });

    // Task Artifacts List
    this.app.get('/api/tasks/:taskId/artifacts', this.authenticate(), (req: Request, res: Response) => {
      const { taskId } = req.params;
      const artifacts = this.artifactStore.getTaskArtifacts(taskId);
      res.json({ taskId, artifacts });
    });

    // Download/Read Artifact (Requires artifacts:read or tasks:read or admin:*)
    this.app.get('/api/artifacts/:artifactId', this.authenticate(), (req: Request, res: Response) => {
      const auth: TokenPayload = (req as any).auth;
      if (!ScopeChecker.hasScope(auth.scopes, 'artifacts:read') &&
          !ScopeChecker.hasScope(auth.scopes, 'tasks:read') &&
          !ScopeChecker.hasScope(auth.scopes, 'admin:*')) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'artifacts:read or tasks:read scope required' });
      }

      const { artifactId } = req.params;
      const meta = this.artifactStore.getArtifactMetadata(artifactId);
      if (!meta) {
        return res.status(404).json({ error: 'ARTIFACT_NOT_FOUND', message: `Artifact ${artifactId} not found` });
      }

      const content = this.artifactStore.readArtifactContent(artifactId);
      if (!content) {
        return res.status(404).json({ error: 'ARTIFACT_CONTENT_NOT_FOUND' });
      }

      res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${meta.name}"`);
      res.send(content);
    });

    // Cancel Task
    this.app.post('/api/tasks/:taskId/cancel', this.authenticate(), (req: Request, res: Response) => {
      const { taskId } = req.params;
      const success = this.taskStore.cancelTask(taskId, req.body.reason || 'Cancelled via API');
      if (!success) {
        return res.status(400).json({ error: 'TASK_CANCEL_FAILED', message: 'Task already completed or not found' });
      }
      res.json({ taskId, status: 'cancelled' });
    });

    // List Connected Devices
    this.app.get('/api/devices', this.authenticate('admin'), (req: Request, res: Response) => {
      const devices = this.authManager.listDevices();
      const connected = this.connectionManager.getConnectedAgents();
      res.json({
        totalRegistered: devices.length,
        totalOnline: connected.length,
        devices: devices.map(d => ({
          ...d,
          isOnline: connected.some(c => c.deviceId === d.deviceId)
        }))
      });
    });

    // Kill Switch Control
    this.app.post('/api/kill-switch', this.authenticate('admin'), (req: Request, res: Response) => {
      const { action, reason, deviceId, clientId } = req.body;

      if (action === 'EMERGENCY_STOP') {
        this.killSwitch.triggerGlobalEmergencyStop(reason);
      } else if (action === 'CLEAR_STOP') {
        this.killSwitch.resetGlobalEmergencyStop();
      } else if (action === 'REVOKE_DEVICE' && deviceId) {
        this.killSwitch.revokeDevice(deviceId, reason);
        this.authManager.revokeDevice(deviceId, reason);
      } else if (action === 'REVOKE_CLIENT' && clientId) {
        this.killSwitch.revokeClient(clientId, reason);
      }

      res.json({
        status: 'OK',
        killSwitchState: this.killSwitch.getState()
      });
    });

    // Audit Logs
    this.app.get('/api/audit', this.authenticate('admin'), (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string) || 100;
      res.json({ logs: this.auditLogger.getRecentLogs(limit) });
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', (socket: any, req: Request) => {
      const ip = req.socket.remoteAddress || 'unknown';
      this.connectionManager.handleConnection(socket, ip);
    });
  }

  public async start(): Promise<void> {
    const port = this.config.port || 4000;
    const host = this.config.host || '0.0.0.0';

    this.leaseMonitor.start();

    return new Promise((resolve) => {
      this.httpServer.listen(port, host, () => {
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    this.leaseMonitor.stop();
    this.wss.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }
}
