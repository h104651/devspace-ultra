import { CloudflareSqliteStorageAdapter } from './sqlite-storage-adapter';
import { CloudflareR2ArtifactStorage, R2Bucket } from './r2-artifact-storage';
import { CloudflareKaggleHttpClient } from '../kaggle/http-client';
import { AuthManager } from '../security/auth-manager';
import { ScopeChecker } from '../security/scope-checker';
import { KillSwitch } from '../security/kill-switch';
import { RateLimiter } from '../security/rate-limiter';
import { AuditLogger } from '../security/audit-logger';
import { TaskStore } from '../storage/task-store';
import { ArtifactStore } from '../storage/artifact-store';
import { IdempotencyStore } from '../storage/idempotency-store';
import { TaskRouter } from '../gateway/task-router';
import { KaggleBackend } from '../kaggle/backend';
import { SwarmOrchestrator } from '../swarm/swarm-orchestrator';
import { McpHandlers } from '../mcp/handlers';
import * as tools from '../mcp/tools';
import { OAuthManager } from '../oauth/oauth-manager';
import { GatewayMessage } from '../types/gateway';
import { TokenPayload } from '../types/auth';

export interface Env {
  GATEWAY_DO: any;
  ARTIFACTS_R2?: R2Bucket;
  MASTER_SECRET?: string;
  KAGGLE_USERNAME?: string;
  KAGGLE_KEY?: string;
  KAGGLE_API_TOKEN?: string;
}

export class GatewayDurableObject {
  private ctx: any;
  private env: Env;
  private storage: CloudflareSqliteStorageAdapter;
  private r2Storage: CloudflareR2ArtifactStorage;
  private kaggleHttpClient: CloudflareKaggleHttpClient;
  private authManager: AuthManager;
  private oauthManager: OAuthManager;
  private killSwitch: KillSwitch;
  private rateLimiter: RateLimiter;
  private auditLogger: AuditLogger;
  private taskStore: TaskStore;
  private artifactStore: ArtifactStore;
  private idempotencyStore: IdempotencyStore;
  private kaggleBackend: KaggleBackend;
  private swarmOrchestrator: SwarmOrchestrator;
  private taskRouter: TaskRouter;
  private mcpHandlers: McpHandlers;

  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;

    // 1. Storage Adapters
    this.storage = new CloudflareSqliteStorageAdapter(ctx.storage.sql);
    this.r2Storage = new CloudflareR2ArtifactStorage(env.ARTIFACTS_R2);

    // 2. Pure HTTP Kaggle Client (using Cloudflare Worker secrets)
    let kaggleUser = env.KAGGLE_USERNAME;
    let kaggleKey = env.KAGGLE_KEY;
    if (env.KAGGLE_API_TOKEN && (!kaggleUser || !kaggleKey)) {
      try {
        const parsed = JSON.parse(env.KAGGLE_API_TOKEN);
        kaggleUser = parsed.username;
        kaggleKey = parsed.key;
      } catch {}
    }

    this.kaggleHttpClient = new CloudflareKaggleHttpClient({
      username: kaggleUser,
      key: kaggleKey,
      isMockMode: !kaggleUser || !kaggleKey
    });

    // 3. Security & Domain Managers
    this.authManager = new AuthManager(env.MASTER_SECRET);
    this.oauthManager = new OAuthManager('https://devspace-ultra-gateway.abdul-hsu.workers.dev', this.authManager, this.storage);
    // Explicitly revoke compromised token
    this.authManager.revokeToken('28524148-f476-4eea-b2f0-0b87f9f48747');
    this.storage.revokeToken('28524148-f476-4eea-b2f0-0b87f9f48747').catch(() => {});

    this.killSwitch = new KillSwitch();
    this.rateLimiter = new RateLimiter();
    this.auditLogger = new AuditLogger();
    this.taskStore = new TaskStore();
    this.artifactStore = new ArtifactStore();
    this.idempotencyStore = new IdempotencyStore();

    this.kaggleBackend = new KaggleBackend(this.taskStore, this.artifactStore);
    this.swarmOrchestrator = new SwarmOrchestrator(this.taskStore);

    this.taskRouter = new TaskRouter(
      this.taskStore,
      this.idempotencyStore,
      this.kaggleBackend,
      this.swarmOrchestrator,
      this.killSwitch,
      this.auditLogger
    );

    const mockGateway: any = {
      taskRouter: this.taskRouter,
      taskStore: this.taskStore,
      artifactStore: this.artifactStore,
      kaggleBackend: this.kaggleBackend,
      swarmOrchestrator: this.swarmOrchestrator,
      authManager: this.authManager,
      killSwitch: this.killSwitch,
      connectionManager: {
        getConnectedAgents: () => this.ctx.getWebSockets().map((ws: any) => ({
          deviceId: ws.deserializeAttachment()?.deviceId || 'unknown',
          platform: 'windows',
          connectedAt: Date.now()
        }))
      }
    };

    this.mcpHandlers = new McpHandlers(mockGateway);
  }

  // --- HTTP Request Handler ---
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

    // WebSocket Upgrade for Local Agent
    if (url.pathname === '/ws/agent') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new (globalThis as any).WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client } as any);
    }

    // CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, WWW-Authenticate, mcp-method, mcp-protocol-version, mcp-session-id',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return Response.json(this.oauthManager.getAuthorizationServerMetadata(), {
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
      });
    }

    // OAuth 2.0 Protected Resource Metadata (RFC 9728 - root and /mcp subpath)
    if ((url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') {
      return Response.json(this.oauthManager.getProtectedResourceMetadata(), {
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
      });
    }

    // Dynamic Client Registration (RFC 7591)
    if (url.pathname === '/oauth/register' && request.method === 'POST') {
      const body = await request.json();
      const client = await this.oauthManager.registerClient(body);
      return Response.json(client, {
        status: 201,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
      });
    }

    // OAuth Authorization Endpoint (GET /oauth/authorize)
    if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
      const clientId = url.searchParams.get('client_id') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256';
      const scope = url.searchParams.get('scope') || '';
      const resource = url.searchParams.get('resource') || '';

      if (!redirectUri) {
        return new Response('Missing redirect_uri parameter', { status: 400 });
      }

      if (url.searchParams.get('auto') === 'true') {
        const code = await this.oauthManager.createAuthorizationCode({
          clientId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          scope,
          state,
          resource
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        return Response.redirect(target.toString(), 302);
      }

      const html = this.oauthManager.renderAuthorizationPage({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        scope,
        resource
      });

      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // OAuth Authorization Form Submit (POST /oauth/authorize)
    if (url.pathname === '/oauth/authorize' && request.method === 'POST') {
      let params: Record<string, string> = {};
      const contentType = request.headers.get('Content-Type') || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        const search = new URLSearchParams(text);
        for (const [k, v] of search.entries()) {
          params[k] = decodeURIComponent(v);
        }
      } else {
        try {
          params = await request.json() as any;
        } catch {}
      }

      const clientId = params.client_id || url.searchParams.get('client_id') || '';
      const redirectUri = params.redirect_uri || url.searchParams.get('redirect_uri') || '';
      const state = params.state || url.searchParams.get('state') || '';
      const codeChallenge = params.code_challenge || url.searchParams.get('code_challenge') || '';
      const codeChallengeMethod = params.code_challenge_method || url.searchParams.get('code_challenge_method') || 'S256';
      const scope = params.scope || url.searchParams.get('scope') || '';
      const resource = params.resource || url.searchParams.get('resource') || '';

      if (!redirectUri) {
        return new Response('Missing redirect_uri', { status: 400 });
      }

      const code = await this.oauthManager.createAuthorizationCode({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
        state,
        resource
      });

      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      if (state) target.searchParams.set('state', state);

      return Response.redirect(target.toString(), 302);
    }

    // OAuth Token Endpoint (POST /oauth/token)
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      let params: Record<string, string> = {};
      const contentType = request.headers.get('Content-Type') || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        const search = new URLSearchParams(text);
        for (const [k, v] of search.entries()) {
          params[k] = v;
        }
      } else {
        try {
          params = await request.json() as any;
        } catch {}
      }

      const grantType = params.grant_type;
      const resource = params.resource || url.searchParams.get('resource') || '';

      if (grantType === 'authorization_code') {
        try {
          const tokens = await this.oauthManager.exchangeCodeForTokens({
            code: params.code,
            clientId: params.client_id,
            redirectUri: params.redirect_uri,
            codeVerifier: params.code_verifier,
            resource
          });
          return Response.json(tokens, {
            status: 200,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Pragma': 'no-cache'
            }
          });
        } catch (err: any) {
          return Response.json({ error: 'invalid_grant', error_description: err.message }, {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
        }
      } else if (grantType === 'refresh_token') {
        try {
          const tokens = await this.oauthManager.refreshAccessToken(params.refresh_token, resource);
          return Response.json(tokens, {
            status: 200,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              'Pragma': 'no-cache'
            }
          });
        } catch (err: any) {
          return Response.json({ error: 'invalid_grant', error_description: err.message }, {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      return Response.json({ error: 'unsupported_grant_type', error_description: `Grant type ${grantType} not supported` }, {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Public Minimal Health check (Unauthenticated liveness only)
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true });
    }

    // Detailed Admin Health check (Requires admin:* or admin:health or admin:killswitch)
    if ((url.pathname === '/admin/health' || url.pathname === '/api/admin/health') && request.method === 'GET') {
      const auth = await this.authenticate(request);
      if (auth.error) return auth.error;

      if (!ScopeChecker.hasScope(auth.payload.scopes, 'admin:health') &&
          !ScopeChecker.hasScope(auth.payload.scopes, 'admin:*') &&
          !ScopeChecker.hasScope(auth.payload.scopes, 'admin:killswitch')) {
        return Response.json({ error: 'FORBIDDEN: admin scope required' }, { status: 403 });
      }

      const connectedCount = this.ctx.getWebSockets().length;
      return Response.json({
        status: 'healthy',
        service: 'devspace-ultra-cloudflare-gateway',
        runtime: 'cloudflare-durable-objects-sqlite',
        r2Available: !!this.env.ARTIFACTS_R2,
        kaggleConfigured: this.kaggleHttpClient.hasCredentials(),
        version: '2.0.0',
        connectedAgents: connectedCount,
        killSwitch: this.killSwitch.getState().globalEmergencyStop ? 'EMERGENCY_STOP' : 'ACTIVE'
      });
    }

    // Streamable HTTP / SSE MCP endpoint (GET /mcp or GET /api/mcp/v1)
    if ((url.pathname === '/mcp' || url.pathname === '/api/mcp/v1') && request.method === 'GET') {
      const auth = await this.authenticate(request);
      if (auth.error) return auth.error;

      const protocolVersion = request.headers.get('mcp-protocol-version') || '2026-07-28';
      const accept = request.headers.get('Accept') || '';
      if (accept.includes('text/event-stream')) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        writer.write(encoder.encode(`event: endpoint\r\ndata: https://devspace-ultra-gateway.abdul-hsu.workers.dev/mcp\r\n\r\n`));
        writer.close();
        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
            'mcp-protocol-version': protocolVersion
          }
        });
      }

      return Response.json({
        name: 'DevSpace Ultra vNext MCP Gateway',
        status: 'active',
        version: '2.0.0',
        protocolVersion
      }, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
          'mcp-protocol-version': protocolVersion,
          'Content-Type': 'application/json'
        }
      });
    }

    // Remote MCP endpoint (POST /mcp or POST /api/mcp/v1)
    if ((url.pathname === '/mcp' || url.pathname === '/api/mcp/v1') && request.method === 'POST') {
      const auth = await this.authenticate(request);
      if (auth.error) return auth.error;

      let body: any = {};
      try {
        const text = await request.text();
        if (text && text.trim().length > 0) {
          body = JSON.parse(text);
        }
      } catch {
        body = {};
      }
      return this.handleRemoteMcp(request, body);
    }

    // REST Task Submit (POST /api/tasks)
    if (url.pathname === '/api/tasks' && request.method === 'POST') {
      const auth = await this.authenticate(request);
      if (auth.error) return auth.error;

      const body = await request.json() as any;
      try {
        const result = await this.taskRouter.routeTaskSubmit(
          body,
          auth.payload.scopes,
          auth.payload.subjectId
        );
        return Response.json(result, { status: 202 });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 400 });
      }
    }

    // Artifact Retrieval (GET /api/artifacts/:artifactId - Requires authentication)
    if (url.pathname.startsWith('/api/artifacts/') && request.method === 'GET') {
      const auth = await this.authenticate(request);
      if (auth.error) return auth.error;

      if (!ScopeChecker.hasScope(auth.payload.scopes, 'artifacts:read') &&
          !ScopeChecker.hasScope(auth.payload.scopes, 'tasks:read') &&
          !ScopeChecker.hasScope(auth.payload.scopes, 'admin:*')) {
        return Response.json({ error: 'FORBIDDEN: artifacts:read or tasks:read scope required' }, { status: 403 });
      }

      const artifactId = url.pathname.replace('/api/artifacts/', '');
      const meta = await this.storage.getArtifactMetadata(artifactId);
      if (!meta) {
        return Response.json({ error: 'ARTIFACT_NOT_FOUND' }, { status: 404 });
      }

      // Check R2 if stored in object storage
      if (this.env.ARTIFACTS_R2) {
        const r2Key = `tasks/${meta.taskId}/${meta.id}_${meta.name}`;
        const content = await this.r2Storage.getArtifactContent(r2Key);
        if (content) {
          return new Response(content, {
            headers: {
              'Content-Type': meta.mimeType || 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${meta.name}"`
            }
          });
        }
      }

      if (meta.preview) {
        return new Response(meta.preview, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      return Response.json({ error: 'ARTIFACT_PAYLOAD_UNAVAILABLE' }, { status: 404 });
    }

    return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('Unhandled exception in GatewayDurableObject fetch:', err);
      return Response.json({
        error: 'INTERNAL_ERROR',
        message: err.message || String(err),
        stack: err.stack
      }, { status: 500 });
    }
  }

  // --- WebSocket Hibernation Handlers ---
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const msg: GatewayMessage = JSON.parse(text);

      if (msg.type === 'AGENT_REGISTER') {
        const val = this.authManager.validateToken(msg.token);
        if (!val.valid) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'AUTH_FAILED' }));
          ws.close(1008, 'Authentication failed');
          return;
        }

        (ws as any).serializeAttachment({ deviceId: msg.deviceId, name: msg.name, capabilities: msg.capabilities });

        ws.send(JSON.stringify({
          type: 'AGENT_REGISTERED',
          messageId: crypto.randomUUID(),
          timestamp: Date.now(),
          deviceId: msg.deviceId
        }));
        return;
      }

      if (msg.type === 'AGENT_HEARTBEAT') {
        ws.send(JSON.stringify({
          type: 'AGENT_HEARTBEAT_ACK',
          messageId: crypto.randomUUID(),
          timestamp: Date.now()
        }));
        return;
      }

      if (msg.type === 'TASK_CLAIM_POLL') {
        const task = this.taskStore.claimTask(msg.deviceId, msg.supportedCapabilities);
        if (task) {
          ws.send(JSON.stringify({
            type: 'TASK_ASSIGNED',
            messageId: crypto.randomUUID(),
            timestamp: Date.now(),
            task
          }));
        }
        return;
      }

      if (msg.type === 'TASK_ACK') {
        this.taskStore.acknowledgeTask(msg.taskId, msg.deviceId);
        return;
      }

      if (msg.type === 'TASK_COMPLETE') {
        this.taskStore.completeTask(msg.taskId, msg.result);
        return;
      }

      if (msg.type === 'TASK_FAIL') {
        this.taskStore.failTask(msg.taskId, msg.error);
        return;
      }
    } catch (err) {
      console.error('Error handling WebSocket message in Durable Object:', err);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // Hibernation cleanup
  }

  private async authenticate(request: Request): Promise<{ payload?: TokenPayload; error?: Response }> {
    const authHeader = request.headers.get('Authorization');
    const protocolVersion = request.headers.get('mcp-protocol-version') || '2026-07-28';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[AUTH_TRACE] No Bearer token provided');
      return {
        error: new Response(JSON.stringify({ error: 'AUTH_REQUIRED', message: 'OAuth Bearer token required' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer resource_metadata="https://devspace-ultra-gateway.abdul-hsu.workers.dev/.well-known/oauth-protected-resource/mcp"',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
            'mcp-protocol-version': protocolVersion
          }
        })
      };
    }

    const token = authHeader.substring(7);
    const validation = this.authManager.validateToken(token);
    if (!validation.valid || !validation.payload) {
      console.log('[AUTH_TRACE] Token invalid:', validation.error);
      return {
        error: new Response(JSON.stringify({ error: 'AUTH_INVALID', message: validation.error }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token"',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
            'mcp-protocol-version': protocolVersion
          }
        })
      };
    }

    // Check token revocation
    if (this.authManager.isTokenRevoked(validation.payload.tokenId) ||
        await this.storage.isTokenRevoked(validation.payload.tokenId)) {
      console.log('[AUTH_TRACE] Token revoked:', validation.payload.tokenId);
      return {
        error: new Response(JSON.stringify({ error: 'TOKEN_REVOKED', message: 'This token has been revoked' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token", error_description="The token has been revoked"',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
            'mcp-protocol-version': protocolVersion
          }
        })
      };
    }

    console.log('[AUTH_TRACE] Token OK for subject:', validation.payload.subjectId, 'scopes:', validation.payload.scopes);
    return { payload: validation.payload };
  }

  private getToolsList() {
    return [
      // Remote Durable Tasks
      { name: 'remote_task_submit', description: 'Submit durable task to local agent, Kaggle, or swarm', inputSchema: tools.REMOTE_TASK_SUBMIT_SCHEMA },
      { name: 'remote_task_status', description: 'Query durable task status', inputSchema: tools.REMOTE_TASK_STATUS_SCHEMA },
      { name: 'remote_task_logs', description: 'Fetch task execution logs', inputSchema: tools.REMOTE_TASK_LOGS_SCHEMA },
      { name: 'remote_task_artifacts', description: 'List task artifacts', inputSchema: tools.REMOTE_TASK_ARTIFACTS_SCHEMA },
      { name: 'remote_task_cancel', description: 'Cancel running task', inputSchema: tools.REMOTE_TASK_CANCEL_SCHEMA },

      // Kaggle Cloud Compute
      { name: 'kaggle_run', description: 'Run Kaggle GPU/CPU execution notebook/script', inputSchema: tools.KAGGLE_RUN_SCHEMA },
      { name: 'kaggle_status', description: 'Check Kaggle execution status', inputSchema: tools.KAGGLE_STATUS_SCHEMA },
      { name: 'kaggle_logs', description: 'Fetch Kaggle execution logs', inputSchema: tools.KAGGLE_LOGS_SCHEMA },
      { name: 'kaggle_result', description: 'Retrieve Kaggle results and artifacts', inputSchema: tools.KAGGLE_RESULT_SCHEMA },

      // Chat Swarm Tools (Full compatibility with legacy and hybrid swarms)
      { name: 'chat_swarm_dispatch', description: 'Dispatch prompt to Chat Swarm worker', inputSchema: tools.CHAT_SWARM_DISPATCH_SCHEMA },
      { name: 'chat_swarm_status', description: 'Check Chat Swarm status and workers', inputSchema: tools.CHAT_SWARM_STATUS_SCHEMA },
      { name: 'chat_swarm_claim', description: 'Claim next available task for worker', inputSchema: tools.SWARM_STATUS_SCHEMA },
      { name: 'chat_swarm_next', description: 'Worker poll next task lease', inputSchema: tools.CHAT_SWARM_NEXT_SCHEMA },
      { name: 'chat_swarm_submit', description: 'Submit worker task completion result', inputSchema: tools.CHAT_SWARM_SUBMIT_SCHEMA },
      { name: 'chat_swarm_cancel', description: 'Cancel swarm task', inputSchema: tools.CHAT_SWARM_CANCEL_SCHEMA },
      { name: 'chat_swarm_wake_bridge', description: 'Trigger browser wake bridge', inputSchema: tools.CHAT_SWARM_WAKE_BRIDGE_SCHEMA },
      { name: 'chat_swarm_runtime_status', description: 'Query Desktop & Browser worker runtime status', inputSchema: tools.CHAT_SWARM_RUNTIME_STATUS_SCHEMA },

      // Swarm Aliases
      { name: 'swarm_dispatch', description: 'Dispatch swarm task', inputSchema: tools.SWARM_DISPATCH_SCHEMA },
      { name: 'swarm_status', description: 'Check swarm status', inputSchema: tools.SWARM_STATUS_SCHEMA }
    ];
  }

  private async handleRemoteMcp(request: Request, body: any): Promise<Response> {
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map(item => this.processSingleMcpItem(request, item)));
      return Response.json(results, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
          'mcp-protocol-version': request.headers.get('mcp-protocol-version') || '2026-07-28',
          'Content-Type': 'application/json'
        }
      });
    }
    return this.processSingleMcpItem(request, body);
  }

  private async processSingleMcpItem(request: Request, body: any): Promise<Response> {
    const method = body?.method || request.headers.get('mcp-method') || 'server/discover';
    const params = body?.params || {};
    const id = body?.id;
    const jsonrpc = body?.jsonrpc || '2.0';
    const protocolVersion = params?.protocolVersion || request.headers.get('mcp-protocol-version') || '2026-07-28';
    const responseId = id !== undefined ? id : 1;

    console.log('[MCP_TRACE] Received MCP method:', method, 'protocolVersion:', protocolVersion, 'id:', responseId);

    const defaultHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'mcp-protocol-version, mcp-session-id, WWW-Authenticate',
      'mcp-protocol-version': protocolVersion,
      'Content-Type': 'application/json'
    };

    // 1. MCP Initialize Handshake
    if (method === 'initialize') {
      return Response.json({
        jsonrpc,
        id: responseId,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: {
            name: 'DevSpace Ultra vNext',
            version: '2.0.0'
          }
        }
      }, {
        headers: defaultHeaders
      });
    }

    // 2. MCP Initialized Notification
    if (method === 'notifications/initialized' || method === 'initialized') {
      return new Response(null, {
        status: 204,
        headers: defaultHeaders
      });
    }

    // 3. Server Discovery (MCP 2026-07-28 server/discover)
    if (method === 'server/discover') {
      return Response.json({
        jsonrpc,
        id: responseId,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          instructions: 'DevSpace Ultra vNext Cloud Gateway for remote tasks, Kaggle cloud compute, and Chat Swarm agents.'
        },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'DevSpace Ultra vNext',
            version: '2.0.0'
          }
        }
      }, {
        headers: defaultHeaders
      });
    }

    // 4. Ping
    if (method === 'ping') {
      return Response.json({
        jsonrpc,
        id: responseId,
        result: {}
      }, {
        headers: defaultHeaders
      });
    }

    // 5. Tools List
    if (method === 'tools/list') {
      return Response.json({
        jsonrpc,
        id: responseId,
        result: {
          tools: this.getToolsList()
        },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: 'DevSpace Ultra vNext',
            version: '2.0.0'
          }
        }
      }, {
        headers: defaultHeaders
      });
    }

    // 6. Resources List
    if (method === 'resources/list') {
      return Response.json({
        jsonrpc,
        id: responseId,
        result: { resources: [] }
      }, {
        headers: defaultHeaders
      });
    }

    // 7. Prompts List
    if (method === 'prompts/list') {
      return Response.json({
        jsonrpc,
        id: responseId,
        result: { prompts: [] }
      }, {
        headers: defaultHeaders
      });
    }

    if (method === 'tools/call') {
      try {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        let result: any;

        switch (toolName) {
          case 'remote_task_submit': result = await this.mcpHandlers.handleRemoteTaskSubmit(toolArgs); break;
          case 'remote_task_status': result = await this.mcpHandlers.handleRemoteTaskStatus(toolArgs); break;
          case 'remote_task_logs': result = await this.mcpHandlers.handleRemoteTaskLogs(toolArgs); break;
          case 'remote_task_artifacts': result = await this.mcpHandlers.handleRemoteTaskArtifacts(toolArgs); break;
          case 'remote_task_cancel': result = await this.mcpHandlers.handleRemoteTaskCancel(toolArgs); break;

          case 'kaggle_run': result = await this.mcpHandlers.handleKaggleRun(toolArgs); break;
          case 'kaggle_status': result = await this.mcpHandlers.handleKaggleStatus(toolArgs); break;
          case 'kaggle_logs': result = await this.mcpHandlers.handleKaggleLogs(toolArgs); break;
          case 'kaggle_result': result = await this.mcpHandlers.handleKaggleResult(toolArgs); break;

          case 'chat_swarm_dispatch':
          case 'swarm_dispatch': result = await this.mcpHandlers.handleChatSwarmDispatch(toolArgs); break;

          case 'chat_swarm_status':
          case 'swarm_status': result = await this.mcpHandlers.handleChatSwarmStatus(toolArgs); break;

          case 'chat_swarm_claim': result = await this.mcpHandlers.handleChatSwarmClaim(toolArgs); break;
          case 'chat_swarm_next': result = await this.mcpHandlers.handleChatSwarmNext(toolArgs); break;
          case 'chat_swarm_submit': result = await this.mcpHandlers.handleChatSwarmSubmit(toolArgs); break;
          case 'chat_swarm_cancel': result = await this.mcpHandlers.handleChatSwarmCancel(toolArgs); break;
          case 'chat_swarm_wake_bridge': result = await this.mcpHandlers.handleChatSwarmWakeBridge(toolArgs); break;
          case 'chat_swarm_runtime_status': result = await this.mcpHandlers.handleChatSwarmRuntimeStatus(); break;

          default:
            return Response.json({ jsonrpc, id: responseId, error: { code: -32601, message: `Tool ${toolName} not found` } }, {
              status: 400,
              headers: defaultHeaders
            });
        }

        return Response.json({
          jsonrpc,
          id: responseId,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }, {
          headers: defaultHeaders
        });
      } catch (err: any) {
        return Response.json({
          jsonrpc,
          id: responseId,
          result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] }
        }, {
          headers: defaultHeaders
        });
      }
    }

    return Response.json({ jsonrpc, id: responseId, error: { code: -32600, message: 'Invalid Request' } }, {
      status: 400,
      headers: defaultHeaders
    });
  }
}
