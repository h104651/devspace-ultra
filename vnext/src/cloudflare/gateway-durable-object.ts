import { CloudflareSqliteStorageAdapter } from './sqlite-storage-adapter';
import { CloudflareR2ArtifactStorage, R2Bucket } from './r2-artifact-storage';
import { CloudflareKaggleHttpClient } from '../kaggle/http-client';
import { AuthManager } from '../security/auth-manager';
import { ScopeChecker } from '../security/scope-checker';
import { isLocalExecutableCapability, LOCAL_EXECUTABLE_CAPABILITIES } from '../local-agent/capabilities';
import { KillSwitch } from '../security/kill-switch';
import { RateLimiter } from '../security/rate-limiter';
import { AuditLogger } from '../security/audit-logger';
import { TaskStore } from '../storage/task-store';
import { ArtifactStore } from '../storage/artifact-store';
import { IdempotencyStore } from '../storage/idempotency-store';
import { TaskRouter } from '../gateway/task-router';
import { KaggleBackend } from '../kaggle/backend';
import { SwarmOrchestrator } from '../swarm/swarm-orchestrator';
import { DurableChatSwarmCompat } from '../swarm/chat-swarm-compat';
import { McpHandlers, McpCallerContext } from '../mcp/handlers';
import * as tools from '../mcp/tools';
import { OAuthManager } from '../oauth/oauth-manager';
import { GatewayMessage } from '../types/gateway';
import { TokenPayload } from '../types/auth';
import {
  MCP_2026_VERSION,
  MCP_SUPPORTED_MODERN_VERSIONS,
  mcpResponseHeaders,
  modernCacheableResult,
  modernResult,
  validateMcpRequest
} from '../mcp/protocol';

export interface Env {
  GATEWAY_DO: any;
  ARTIFACTS_R2?: R2Bucket;
  MASTER_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  KAGGLE_USERNAME?: string;
  KAGGLE_KEY?: string;
  KAGGLE_API_TOKEN?: string;
}

const DEFAULT_PUBLIC_BASE_URL = 'https://devspace-ultra-gateway.abdul-hsu.workers.dev';
const KAGGLE_POLLS_STORAGE_KEY = 'devspace:kaggle-polls:v1';
const DEFAULT_KAGGLE_POLL_MS = 15000;
const SWARM_EVENT_POLL_MS = 1500;
const SWARM_CHECKPOINT_WAIT_MS = 25000;

interface PendingKagglePoll {
  taskId: string;
  kernelSlug: string;
  dueAt: number;
}

type PendingKagglePolls = Record<string, PendingKagglePoll>;

export class GatewayDurableObject {
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
  private chatSwarmCompat: DurableChatSwarmCompat;
  private taskRouter: TaskRouter;
  private mcpHandlers: McpHandlers;
  private ready: Promise<void>;
  private baseUrl: string;

  constructor(private ctx: any, private env: Env) {
    if (!env.MASTER_SECRET || env.MASTER_SECRET.length < 32) {
      throw new Error('MASTER_SECRET is required in Cloudflare and must be at least 32 characters; refusing ephemeral token signing keys');
    }

    this.baseUrl = (env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
    this.storage = new CloudflareSqliteStorageAdapter(ctx.storage.sql);
    this.r2Storage = new CloudflareR2ArtifactStorage(env.ARTIFACTS_R2);

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

    this.authManager = new AuthManager(env.MASTER_SECRET);
    this.oauthManager = new OAuthManager(this.baseUrl, this.authManager, this.storage);
    this.killSwitch = new KillSwitch();
    this.rateLimiter = new RateLimiter();
    this.auditLogger = new AuditLogger(undefined, this.storage);
    this.taskStore = new TaskStore(undefined, 60000, this.storage);
    this.idempotencyStore = new IdempotencyStore(undefined, 24 * 3600 * 1000, this.storage);
    this.chatSwarmCompat = new DurableChatSwarmCompat(ctx.storage);

    const persistArtifactPayload = async (meta: any, bytes: Uint8Array) => {
      const pending = this.r2Storage.saveArtifactPayload(meta, bytes);
      if (typeof this.ctx.waitUntil === 'function') this.ctx.waitUntil(pending);
      await pending;
    };
    this.artifactStore = new ArtifactStore(undefined, 50 * 1024 * 1024, this.storage, persistArtifactPayload);

    this.kaggleBackend = new KaggleBackend(
      this.taskStore,
      this.artifactStore,
      this.kaggleHttpClient as any,
      undefined,
      DEFAULT_KAGGLE_POLL_MS,
      { schedule: (taskId, kernelSlug, delayMs) => this.scheduleKagglePoll(taskId, kernelSlug, delayMs) }
    );
    this.swarmOrchestrator = new SwarmOrchestrator(this.taskStore);
    this.taskRouter = new TaskRouter(
      this.taskStore,
      this.idempotencyStore,
      this.kaggleBackend,
      this.swarmOrchestrator,
      this.killSwitch,
      this.auditLogger
    );

    const gatewayFacade: any = {
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
    this.mcpHandlers = new McpHandlers(gatewayFacade);

    this.ready = this.initializeFromDurableStorage();
    if (typeof this.ctx.blockConcurrencyWhile === 'function') {
      this.ctx.blockConcurrencyWhile(() => this.ready);
    }
  }

  private async initializeFromDurableStorage(): Promise<void> {
    try {
      this.taskStore.hydrate(await this.storage.listTasks());
      this.taskStore.recoverStaleTasks();
    } catch (err) {
      console.error('Failed to hydrate durable task state:', err);
    }
    try {
      this.artifactStore.hydrate(await this.storage.listArtifacts());
    } catch (err) {
      console.error('Failed to hydrate artifact metadata:', err);
    }
    try {
      await this.rearmKaggleAlarm();
    } catch (err) {
      console.error('Failed to rearm durable Kaggle poll alarm:', err);
    }
  }

  private async readPendingKagglePolls(): Promise<PendingKagglePolls> {
    if (typeof this.ctx.storage?.get !== 'function') return {};
    const stored = await this.ctx.storage.get(KAGGLE_POLLS_STORAGE_KEY);
    if (!stored) return {};
    if (typeof stored === 'string') {
      try { return JSON.parse(stored) as PendingKagglePolls; } catch { return {}; }
    }
    return stored as PendingKagglePolls;
  }

  private async writePendingKagglePolls(polls: PendingKagglePolls): Promise<void> {
    if (typeof this.ctx.storage?.put !== 'function') return;
    await this.ctx.storage.put(KAGGLE_POLLS_STORAGE_KEY, polls);
  }

  private async scheduleKagglePoll(taskId: string, kernelSlug: string, delayMs = DEFAULT_KAGGLE_POLL_MS): Promise<void> {
    if (typeof this.ctx.storage?.put !== 'function' || typeof this.ctx.storage?.setAlarm !== 'function') return;
    const polls = await this.readPendingKagglePolls();
    polls[taskId] = { taskId, kernelSlug, dueAt: Date.now() + Math.max(1000, delayMs) };
    await this.writePendingKagglePolls(polls);
    await this.rearmKaggleAlarm(polls);
  }

  private async rearmKaggleAlarm(polls?: PendingKagglePolls): Promise<void> {
    if (typeof this.ctx.storage?.setAlarm !== 'function') return;
    const current = polls || await this.readPendingKagglePolls();
    const entries = Object.values(current);
    if (entries.length === 0) {
      if (typeof this.ctx.storage?.deleteAlarm === 'function') await this.ctx.storage.deleteAlarm();
      return;
    }
    const earliest = Math.min(...entries.map(item => item.dueAt));
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, earliest));
  }

  async alarm(): Promise<void> {
    await this.ready;
    const polls = await this.readPendingKagglePolls();
    const now = Date.now();
    const due = Object.values(polls).filter(item => item.dueAt <= now + 250);

    for (const item of due) {
      try {
        const stillRunning = await this.kaggleBackend.pollKaggleTask(item.taskId, item.kernelSlug, false);
        if (stillRunning) {
          polls[item.taskId] = { ...item, dueAt: Date.now() + DEFAULT_KAGGLE_POLL_MS };
        } else {
          delete polls[item.taskId];
        }
      } catch (err: any) {
        console.error(`Durable Kaggle poll failed for ${item.taskId}:`, err?.message || String(err));
        polls[item.taskId] = { ...item, dueAt: Date.now() + DEFAULT_KAGGLE_POLL_MS };
      }
    }

    await this.writePendingKagglePolls(polls);
    await this.rearmKaggleAlarm(polls);
  }

  private corsHeaders(): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, WWW-Authenticate, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Chat-Swarm-Browser-Token, X-Chat-Swarm-Worker-Token',
      'Access-Control-Expose-Headers': 'MCP-Protocol-Version, WWW-Authenticate',
      'Access-Control-Max-Age': '86400'
    };
  }

  private async parseJsonRequest(request: Request): Promise<any> {
    try {
      return await request.json();
    } catch {
      throw new Error('Invalid JSON request body.');
    }
  }

  private browserBridgeError(error: any, status = 401): Response {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status, headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' } }
    );
  }

  private eventStream(
    eventSource: () => Promise<any>,
    onCancel?: () => Promise<any> | void
  ): Response {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let running = false;
    let lastSerialized = '';
    let lastSentAt = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const stop = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          try { controller.close(); } catch {}
        };

        const emit = async () => {
          if (closed || running) return;
          running = true;
          try {
            const event = await eventSource();
            const serialized = JSON.stringify(event);
            const now = Date.now();
            if (serialized !== lastSerialized || now - lastSentAt >= 15000) {
              controller.enqueue(encoder.encode(`data: ${serialized}\n\n`));
              lastSerialized = serialized;
              lastSentAt = now;
            } else {
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            }
            if (event.type === 'closed') stop();
          } catch {
            try {
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'bridge_state_unavailable' })}\n\n`));
            } catch {}
            stop();
          } finally {
            running = false;
          }
        };

        void emit();
        timer = setInterval(() => void emit(), SWARM_EVENT_POLL_MS);
      },
      cancel() {
        closed = true;
        if (timer) clearInterval(timer);
        if (onCancel) void onCancel();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...this.corsHeaders(),
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-cache',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  private async handleBrowserBridge(request: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === '/chat-swarm/browser-bind' && request.method === 'POST') {
      try {
        const body = await this.parseJsonRequest(request);
        return Response.json(await this.chatSwarmCompat.bindBrowser(body?.code), {
          headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
        });
      } catch (err) {
        return this.browserBridgeError(err);
      }
    }

    if (url.pathname === '/chat-swarm/browser-bind-invite' && request.method === 'POST') {
      try {
        const body = await this.parseJsonRequest(request);
        return Response.json(await this.chatSwarmCompat.bindBrowserByInvite(body?.inviteCode), {
          headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
        });
      } catch (err) {
        return this.browserBridgeError(err);
      }
    }

    if (url.pathname === '/chat-swarm/browser-direct-join' && request.method === 'POST') {
      try {
        const body = await this.parseJsonRequest(request);
        if (!body?.pageKey) throw new Error('Browser page key is required.');
        return Response.json(await this.chatSwarmCompat.joinBrowserDirect({
          inviteCode: body?.inviteCode,
          label: body?.label,
          pageKey: body.pageKey
        }), {
          headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
        });
      } catch (err) {
        return this.browserBridgeError(err, 409);
      }
    }

    if (url.pathname === '/chat-swarm/browser-claim' && request.method === 'POST') {
      const token = request.headers.get('X-Chat-Swarm-Browser-Token') || '';
      if (!token) return this.browserBridgeError(new Error('Browser wake token is required.'));
      try {
        return Response.json(await this.chatSwarmCompat.browserClaim(token), {
          headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
        });
      } catch (err) {
        return this.browserBridgeError(err);
      }
    }

    if (url.pathname === '/chat-swarm/browser-events' && request.method === 'GET') {
      const token = request.headers.get('X-Chat-Swarm-Browser-Token') || '';
      if (!token) return this.browserBridgeError(new Error('Browser wake token is required.'));
      try {
        await this.chatSwarmCompat.browserEvent(token);
      } catch (err) {
        return this.browserBridgeError(err);
      }
      return this.eventStream(
        () => this.chatSwarmCompat.browserEvent(token),
        () => this.chatSwarmCompat.setBrowserOnline(token, false).catch(() => undefined)
      );
    }

    if (url.pathname === '/chat-swarm/worker-events' && request.method === 'GET') {
      const token = request.headers.get('X-Chat-Swarm-Worker-Token') || '';
      if (!token) return this.browserBridgeError(new Error('Worker token is required.'));
      try {
        await this.chatSwarmCompat.workerEvent(token);
      } catch (err) {
        return this.browserBridgeError(err);
      }
      return this.eventStream(
        () => this.chatSwarmCompat.workerEvent(token),
        () => this.chatSwarmCompat.setDockOnline(token, false).catch(() => undefined)
      );
    }

    return undefined;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
      const url = new URL(request.url);

      if (url.pathname === '/ws/agent') {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Expected WebSocket upgrade', { status: 426 });
        }
        const pair = new (globalThis as any).WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client } as any);
      }

      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: this.corsHeaders() });

      const browserBridgeResponse = await this.handleBrowserBridge(request, url);
      if (browserBridgeResponse) return browserBridgeResponse;

      if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
        return Response.json(this.oauthManager.getAuthorizationServerMetadata(), { headers: this.corsHeaders() });
      }
      if ((url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') {
        return Response.json(this.oauthManager.getProtectedResourceMetadata(), { headers: this.corsHeaders() });
      }

      if (url.pathname === '/oauth/register' && request.method === 'POST') {
        try {
          const body = await request.json();
          const client = await this.oauthManager.registerClient(body);
          return Response.json(client, { status: 201, headers: this.corsHeaders() });
        } catch (err: any) {
          return Response.json(
            { error: 'invalid_client_metadata', error_description: err.message },
            { status: 400, headers: this.corsHeaders() }
          );
        }
      }

      if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
        const params = {
          clientId: url.searchParams.get('client_id') || '',
          redirectUri: url.searchParams.get('redirect_uri') || '',
          state: url.searchParams.get('state') || '',
          codeChallenge: url.searchParams.get('code_challenge') || '',
          codeChallengeMethod: url.searchParams.get('code_challenge_method') || '',
          scope: url.searchParams.get('scope') || '',
          resource: url.searchParams.get('resource') || `${this.baseUrl}/mcp`
        };
        if (!params.clientId || !params.redirectUri || !params.codeChallenge || params.codeChallengeMethod !== 'S256') {
          return new Response('Invalid OAuth authorization request: client_id, redirect_uri and PKCE S256 are required', { status: 400 });
        }
        return new Response(this.oauthManager.renderAuthorizationPage(params), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'self';"
          }
        });
      }

      if (url.pathname === '/oauth/authorize' && request.method === 'POST') {
        try {
          const contentType = request.headers.get('Content-Type') || '';
          const params: Record<string, string> = {};
          if (contentType.includes('application/x-www-form-urlencoded')) {
            const form = new URLSearchParams(await request.text());
            for (const [k, v] of form.entries()) params[k] = v;
          } else {
            Object.assign(params, await request.json());
          }
          const code = await this.oauthManager.createAuthorizationCode({
            clientId: params.client_id || '',
            redirectUri: params.redirect_uri || '',
            state: params.state,
            codeChallenge: params.code_challenge,
            codeChallengeMethod: params.code_challenge_method,
            scope: params.scope,
            resource: params.resource
          });
          return Response.redirect(this.oauthManager.buildAuthorizationRedirect(params.redirect_uri, code, params.state), 302);
        } catch (err: any) {
          return Response.json(
            { error: 'invalid_request', error_description: err.message },
            { status: 400, headers: this.corsHeaders() }
          );
        }
      }

      if (url.pathname === '/oauth/token' && request.method === 'POST') {
        const params: Record<string, string> = {};
        try {
          const contentType = request.headers.get('Content-Type') || '';
          if (contentType.includes('application/x-www-form-urlencoded')) {
            const form = new URLSearchParams(await request.text());
            for (const [k, v] of form.entries()) params[k] = v;
          } else {
            Object.assign(params, await request.json());
          }
        } catch {
          return Response.json(
            { error: 'invalid_request', error_description: 'Unable to parse token request' },
            { status: 400, headers: this.corsHeaders() }
          );
        }

        try {
          if (params.grant_type === 'authorization_code') {
            const tokens = await this.oauthManager.exchangeCodeForTokens({
              code: params.code,
              clientId: params.client_id,
              redirectUri: params.redirect_uri,
              codeVerifier: params.code_verifier,
              resource: params.resource
            });
            return Response.json(tokens, {
              headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store', 'Pragma': 'no-cache' }
            });
          }
          if (params.grant_type === 'refresh_token') {
            const tokens = await this.oauthManager.refreshAccessToken(params.refresh_token, params.resource);
            return Response.json(tokens, {
              headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store', 'Pragma': 'no-cache' }
            });
          }
          return Response.json({ error: 'unsupported_grant_type' }, { status: 400, headers: this.corsHeaders() });
        } catch (err: any) {
          const error = err.message?.startsWith('INVALID_TARGET')
            ? 'invalid_target'
            : err.message?.startsWith('INVALID_REQUEST')
              ? 'invalid_request'
              : 'invalid_grant';
          return Response.json(
            { error, error_description: err.message },
            { status: 400, headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' } }
          );
        }
      }

      if (url.pathname === '/health' && request.method === 'GET') {
        return Response.json({ ok: true });
      }

      if ((url.pathname === '/admin/health' || url.pathname === '/api/admin/health') && request.method === 'GET') {
        const auth = await this.authenticate(request);
        if (auth.error) return auth.error;
        if (!ScopeChecker.hasScope(auth.payload!.scopes, 'admin:health')) {
          return Response.json({ error: 'FORBIDDEN: admin:health scope required' }, { status: 403 });
        }
        return Response.json({
          status: 'healthy',
          service: 'devspace-ultra-cloudflare-gateway',
          runtime: 'cloudflare-durable-objects-sqlite',
          r2Available: !!this.env.ARTIFACTS_R2,
          kaggleConfigured: this.kaggleHttpClient.hasCredentials(),
          version: '2.0.1',
          connectedAgents: this.ctx.getWebSockets().length,
          killSwitch: this.killSwitch.getState().globalEmergencyStop ? 'EMERGENCY_STOP' : 'ACTIVE'
        });
      }

      if ((url.pathname === '/mcp' || url.pathname === '/api/mcp/v1') && request.method === 'GET') {
        if (request.headers.get('MCP-Protocol-Version') === MCP_2026_VERSION) {
          return new Response(null, {
            status: 405,
            headers: { ...this.corsHeaders(), 'Allow': 'POST', 'MCP-Protocol-Version': MCP_2026_VERSION }
          });
        }
        const auth = await this.authenticate(request, true);
        if (auth.error) return auth.error;
        if (!(request.headers.get('Accept') || '').includes('text/event-stream')) {
          return new Response(null, { status: 405, headers: { ...this.corsHeaders(), 'Allow': 'POST' } });
        }
        return new Response(`event: endpoint\r\ndata: ${this.baseUrl}/mcp\r\n\r\n`, {
          status: 200,
          headers: { ...this.corsHeaders(), 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
        });
      }

      if ((url.pathname === '/mcp' || url.pathname === '/api/mcp/v1') && request.method === 'POST') {
        const auth = await this.authenticate(request, true);
        if (auth.error) return auth.error;

        let body: any;
        try {
          const text = await request.text();
          body = text ? JSON.parse(text) : {};
        } catch {
          return Response.json(
            { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
            { status: 400, headers: this.corsHeaders() }
          );
        }
        if (Array.isArray(body)) {
          return Response.json(
            { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC batches are not supported by this endpoint' } },
            { status: 400, headers: this.corsHeaders() }
          );
        }

        const validation = validateMcpRequest(request.headers, body);
        if ('status' in validation) {
          return Response.json(validation.body, { status: validation.status, headers: this.corsHeaders() });
        }
        return this.processSingleMcpItem(body, auth.payload!, validation.modern, validation.protocolVersion);
      }

      if (url.pathname === '/api/tasks' && request.method === 'POST') {
        const auth = await this.authenticate(request);
        if (auth.error) return auth.error;
        const body = await request.json() as any;
        try {
          const result = await this.taskRouter.routeTaskSubmit(body, auth.payload!.scopes, auth.payload!.subjectId);
          return Response.json(result, { status: 202 });
        } catch (err: any) {
          const status = err.message?.includes('AUTH_FORBIDDEN') ? 403 : 400;
          return Response.json({ error: err.message }, { status });
        }
      }

      if (url.pathname.startsWith('/api/tasks/') && request.method === 'GET') {
        const auth = await this.authenticate(request);
        if (auth.error) return auth.error;
        if (!ScopeChecker.hasScope(auth.payload!.scopes, 'tasks:read')) {
          return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
        }
        const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length));
        const task = this.taskStore.getTask(taskId);
        return task ? Response.json(task) : Response.json({ error: 'TASK_NOT_FOUND' }, { status: 404 });
      }

      if (url.pathname.startsWith('/api/artifacts/') && request.method === 'GET') {
        const auth = await this.authenticate(request);
        if (auth.error) return auth.error;
        if (!ScopeChecker.hasScope(auth.payload!.scopes, 'artifacts:read') && !ScopeChecker.hasScope(auth.payload!.scopes, 'tasks:read')) {
          return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
        }
        const artifactId = decodeURIComponent(url.pathname.slice('/api/artifacts/'.length));
        const meta = this.artifactStore.getArtifactMetadata(artifactId) || await this.storage.getArtifactMetadata(artifactId);
        if (!meta) return Response.json({ error: 'ARTIFACT_NOT_FOUND' }, { status: 404 });
        const content = await this.r2Storage.getArtifact(meta);
        if (content) {
          return new Response(content, {
            headers: {
              'Content-Type': meta.mimeType || 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${meta.name.replace(/"/g, '')}"`
            }
          });
        }
        if (meta.preview !== undefined) {
          return new Response(meta.preview, { headers: { 'Content-Type': meta.mimeType || 'text/plain; charset=utf-8' } });
        }
        return Response.json({ error: 'ARTIFACT_PAYLOAD_UNAVAILABLE' }, { status: 404 });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('Unhandled exception in GatewayDurableObject fetch:', err);
      return Response.json({ error: 'INTERNAL_ERROR', message: err.message || String(err) }, { status: 500 });
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    await this.ready;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const msg: GatewayMessage = JSON.parse(text);

      if (msg.type === 'AGENT_REGISTER') {
        const val = this.authManager.validateToken(msg.token);
        if (!val.valid || !val.payload || val.payload.type !== 'device' || await this.storage.isTokenRevoked(val.payload.tokenId)) {
          ws.send(JSON.stringify({
            type: 'ERROR',
            error: `AUTH_FAILED: Device token required (received ${val.payload?.type || 'invalid'})`
          }));
          ws.close(1008, 'Authentication failed');
          return;
        }

        if (msg.deviceId && val.payload.subjectId !== msg.deviceId) {
          ws.send(JSON.stringify({
            type: 'ERROR',
            error: `AUTH_FAILED: deviceId mismatch (token subject: ${val.payload.subjectId}, message deviceId: ${msg.deviceId})`
          }));
          ws.close(1008, 'Authentication failed');
          return;
        }

        const authoritativeDeviceId = val.payload.subjectId;
        const requestedCaps = (Array.isArray(msg.capabilities) && msg.capabilities.length > 0)
          ? msg.capabilities
          : [...LOCAL_EXECUTABLE_CAPABILITIES];

        const authorizedCaps = requestedCaps.filter(cap => {
          if (!isLocalExecutableCapability(cap)) return false;
          const requiredScope = ScopeChecker.getRequiredScopeForCapability(cap);
          return ScopeChecker.hasScope(val.payload!.scopes, requiredScope);
        });

        this.authManager.rememberAuthenticatedDevice(msg.token, authoritativeDeviceId, msg.name || authoritativeDeviceId, authorizedCaps, (msg.platform as any) || 'windows');
        (ws as any).serializeAttachment({
          deviceId: authoritativeDeviceId,
          name: msg.name || authoritativeDeviceId,
          capabilities: authorizedCaps
        });

        ws.send(JSON.stringify({
          type: 'AGENT_REGISTERED',
          messageId: (msg as any).messageId || crypto.randomUUID(),
          timestamp: Date.now(),
          deviceId: authoritativeDeviceId
        }));
        return;
      }

      const attachment = (ws as any).deserializeAttachment() as { deviceId: string; capabilities: string[]; name?: string } | null;
      if (!attachment || !attachment.deviceId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'AUTH_REQUIRED: Must authenticate with AGENT_REGISTER first' }));
        ws.close(1008, 'Unauthorized');
        return;
      }

      const authenticatedDeviceId = attachment.deviceId;
      const authorizedCapabilities = attachment.capabilities || [];

      if (msg.type === 'AGENT_HEARTBEAT') {
        this.authManager.updateDeviceHeartbeat(authenticatedDeviceId);
        if (msg.activeTaskIds && Array.isArray(msg.activeTaskIds)) {
          for (const tid of msg.activeTaskIds) {
            const task = this.taskStore.getTask(tid);
            if (task && task.lease?.claimedBy === authenticatedDeviceId) {
              this.taskStore.renewLease(tid, authenticatedDeviceId);
            }
          }
        }
        ws.send(JSON.stringify({
          type: 'AGENT_HEARTBEAT_ACK',
          messageId: (msg as any).messageId || crypto.randomUUID(),
          timestamp: Date.now()
        }));
        return;
      }

      if (msg.type === 'TASK_CLAIM_POLL') {
        this.taskStore.recoverStaleTasks();
        const task = this.taskStore.claimTask(authenticatedDeviceId, authorizedCapabilities);
        if (task) {
          ws.send(JSON.stringify({
            type: 'TASK_ASSIGNED',
            messageId: (msg as any).messageId || crypto.randomUUID(),
            timestamp: Date.now(),
            task
          }));
        }
        return;
      }

      if (msg.type === 'TASK_ACK') {
        const task = this.taskStore.getTask(msg.taskId);
        if (!task || task.lease?.claimedBy !== authenticatedDeviceId) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'LEASE_VIOLATION: Task lease not owned by device' }));
          return;
        }
        this.taskStore.acknowledgeTask(msg.taskId, authenticatedDeviceId);
        return;
      }

      if (msg.type === 'TASK_PROGRESS') {
        const task = this.taskStore.getTask(msg.taskId);
        if (task && task.lease?.claimedBy === authenticatedDeviceId) {
          this.taskStore.startTask(msg.taskId, authenticatedDeviceId);
          this.taskStore.appendLogs(msg.taskId, [`[PROGRESS] ${msg.stage} ${msg.percent !== undefined ? msg.percent + '%' : ''}`]);
        }
        return;
      }

      if (msg.type === 'TASK_LOG_APPEND') {
        const task = this.taskStore.getTask(msg.taskId);
        if (task && task.lease?.claimedBy === authenticatedDeviceId) {
          this.taskStore.appendLogs(msg.taskId, msg.lines);
        }
        return;
      }

      if (msg.type === 'TASK_COMPLETE') {
        const task = this.taskStore.getTask(msg.taskId);
        if (!task || task.lease?.claimedBy !== authenticatedDeviceId) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'LEASE_VIOLATION: Task lease not owned by device' }));
          return;
        }
        this.taskStore.completeTask(msg.taskId, msg.result);
        return;
      }

      if (msg.type === 'TASK_FAIL') {
        const task = this.taskStore.getTask(msg.taskId);
        if (!task || task.lease?.claimedBy !== authenticatedDeviceId) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'LEASE_VIOLATION: Task lease not owned by device' }));
          return;
        }
        this.taskStore.failTask(msg.taskId, msg.error);
        return;
      }
    } catch (err) {
      console.error('Error handling WebSocket message in Durable Object:', err);
    }
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string) {}

  private async authenticate(request: Request, requireMcpAccess = false): Promise<{ payload?: TokenPayload; error?: Response }> {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return {
        error: new Response(JSON.stringify({ error: 'AUTH_REQUIRED', message: 'OAuth Bearer token required' }), {
          status: 401,
          headers: {
            ...this.corsHeaders(),
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${this.baseUrl}/.well-known/oauth-protected-resource/mcp"`
          }
        })
      };
    }

    const validation = this.authManager.validateToken(authHeader.substring(7));
    if (!validation.valid || !validation.payload) {
      return {
        error: new Response(JSON.stringify({ error: 'AUTH_INVALID', message: validation.error }), {
          status: 401,
          headers: {
            ...this.corsHeaders(),
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token"'
          }
        })
      };
    }
    const payload = validation.payload;
    if (payload.metadata?.purpose === 'refresh_token') {
      return {
        error: new Response(JSON.stringify({ error: 'AUTH_INVALID', message: 'Refresh tokens cannot be used as bearer access tokens' }), {
          status: 401,
          headers: {
            ...this.corsHeaders(),
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="invalid_token"'
          }
        })
      };
    }
    if (payload.metadata?.purpose === 'access_token' && payload.metadata?.resource && payload.metadata.resource !== `${this.baseUrl}/mcp`) {
      return {
        error: Response.json(
          { error: 'AUTH_INVALID', message: 'Access token is bound to a different resource' },
          { status: 401, headers: this.corsHeaders() }
        )
      };
    }
    if (this.authManager.isTokenRevoked(payload.tokenId) || await this.storage.isTokenRevoked(payload.tokenId)) {
      return {
        error: Response.json(
          { error: 'TOKEN_REVOKED' },
          { status: 401, headers: { ...this.corsHeaders(), 'WWW-Authenticate': 'Bearer error="invalid_token"' } }
        )
      };
    }
    if (requireMcpAccess && !ScopeChecker.hasScope(payload.scopes, 'mcp:access')) {
      return {
        error: Response.json(
          { error: 'AUTH_FORBIDDEN', message: 'mcp:access scope required' },
          { status: 403, headers: this.corsHeaders() }
        )
      };
    }
    return { payload };
  }

  private getToolsList() {
    return [
      { name: 'remote_task_submit', description: 'Submit durable task to local agent, Kaggle, browser, or swarm backend', inputSchema: tools.REMOTE_TASK_SUBMIT_SCHEMA },
      { name: 'remote_task_status', description: 'Query durable task status', inputSchema: tools.REMOTE_TASK_STATUS_SCHEMA },
      { name: 'remote_task_logs', description: 'Fetch task execution logs', inputSchema: tools.REMOTE_TASK_LOGS_SCHEMA },
      { name: 'remote_task_artifacts', description: 'List task artifacts', inputSchema: tools.REMOTE_TASK_ARTIFACTS_SCHEMA },
      { name: 'remote_task_cancel', description: 'Cancel active task', inputSchema: tools.REMOTE_TASK_CANCEL_SCHEMA },
      { name: 'kaggle_run', description: 'Run code on Kaggle backend', inputSchema: tools.KAGGLE_RUN_SCHEMA },
      { name: 'kaggle_status', description: 'Check Kaggle execution status', inputSchema: tools.KAGGLE_STATUS_SCHEMA },
      { name: 'kaggle_logs', description: 'Fetch Kaggle execution logs', inputSchema: tools.KAGGLE_LOGS_SCHEMA },
      { name: 'kaggle_result', description: 'Retrieve Kaggle results and artifacts', inputSchema: tools.KAGGLE_RESULT_SCHEMA },

      { name: 'chat_swarm_create', description: 'Create a durable Chat Swarm and return an invite code plus private orchestrator token', inputSchema: tools.CHAT_SWARM_CREATE_SCHEMA },
      { name: 'chat_swarm_join', description: 'Join an existing Chat Swarm worker slot using its invite code', inputSchema: tools.CHAT_SWARM_JOIN_SCHEMA },
      { name: 'chat_swarm_dock', description: 'Mount the persistent Worker Dock stream for an existing worker token', inputSchema: tools.CHAT_SWARM_DOCK_SCHEMA },
      { name: 'chat_swarm_join_browser', description: 'Join a Chat Swarm and prepare the browser wake bridge binding marker', inputSchema: tools.CHAT_SWARM_JOIN_BROWSER_SCHEMA },
      { name: 'chat_swarm_status', description: 'Return durable Chat Swarm roster, capacity and task counts', inputSchema: tools.CHAT_SWARM_STATUS_SCHEMA },
      { name: 'chat_swarm_resize', description: 'Resize an active Chat Swarm without interrupting protected workers', inputSchema: tools.CHAT_SWARM_RESIZE_SCHEMA },
      { name: 'chat_swarm_dispatch', description: 'Atomically dispatch a batch of idempotent Chat Swarm tasks', inputSchema: tools.CHAT_SWARM_DISPATCH_SCHEMA },
      { name: 'chat_swarm_claim', description: 'Claim one immediately available task for an existing worker token', inputSchema: tools.CHAT_SWARM_CLAIM_SCHEMA },
      { name: 'chat_swarm_ack', description: 'Acknowledge that a claimed worker task actually resumed execution', inputSchema: tools.CHAT_SWARM_ACK_SCHEMA },
      { name: 'chat_swarm_next', description: 'Park for one bounded worker checkpoint and claim work when it arrives', inputSchema: tools.CHAT_SWARM_NEXT_SCHEMA },
      { name: 'chat_swarm_recover', description: 'Recover an interrupted worker wait with one bounded checkpoint', inputSchema: tools.CHAT_SWARM_RECOVER_SCHEMA },
      { name: 'chat_swarm_submit_once', description: 'Submit one browser/dock-woken worker result without re-parking', inputSchema: tools.CHAT_SWARM_SUBMIT_ONCE_SCHEMA },
      { name: 'chat_swarm_submit', description: 'Submit a worker result and immediately re-park for the next bounded checkpoint', inputSchema: tools.CHAT_SWARM_SUBMIT_SCHEMA },
      { name: 'chat_swarm_collect', description: 'Collect selected Chat Swarm task results with optional bounded waiting', inputSchema: tools.CHAT_SWARM_COLLECT_SCHEMA },
      { name: 'chat_swarm_cancel', description: 'Cancel queued or claimed Chat Swarm tasks', inputSchema: tools.CHAT_SWARM_CANCEL_SCHEMA },
      { name: 'chat_swarm_recycle_worker', description: 'Recycle a dead worker and safely requeue unacknowledged work', inputSchema: tools.CHAT_SWARM_RECYCLE_WORKER_SCHEMA },
      { name: 'chat_swarm_leave', description: 'Leave a Chat Swarm worker slot and requeue safe in-flight work', inputSchema: tools.CHAT_SWARM_LEAVE_SCHEMA },
      { name: 'chat_swarm_close', description: 'Close a Chat Swarm and optionally cancel pending work', inputSchema: tools.CHAT_SWARM_CLOSE_SCHEMA },
      { name: 'chat_swarm_wake_bridge', description: 'Report Cloudflare Browser Wake Bridge and Worker Dock stream endpoint status', inputSchema: tools.CHAT_SWARM_WAKE_BRIDGE_SCHEMA },
      { name: 'chat_swarm_runtime_status', description: 'Query connected outbound Windows agent/runtime status', inputSchema: tools.CHAT_SWARM_RUNTIME_STATUS_SCHEMA },

      { name: 'swarm_dispatch', description: 'Dispatch simplified vNext swarm task', inputSchema: tools.SWARM_DISPATCH_SCHEMA },
      { name: 'swarm_status', description: 'Check simplified vNext swarm status', inputSchema: tools.SWARM_STATUS_SCHEMA },
      { name: 'device_status', description: 'Inspect local agent status', inputSchema: tools.DEVICE_STATUS_SCHEMA },
      { name: 'kill_switch_trigger', description: 'Administrative emergency-stop and revocation control', inputSchema: tools.KILL_SWITCH_TRIGGER_SCHEMA }
    ];
  }

  private requireSwarmScope(auth: TokenPayload): void {
    if (!ScopeChecker.hasScope(auth.scopes, 'swarm:dispatch')) {
      throw new Error('AUTH_FORBIDDEN: swarm:dispatch scope required');
    }
  }

  private async callLegacyChatSwarmTool(toolName: string, args: any, auth: TokenPayload): Promise<{ handled: boolean; result?: any }> {
    if (!toolName.startsWith('chat_swarm_')) return { handled: false };
    this.requireSwarmScope(auth);

    switch (toolName) {
      case 'chat_swarm_create':
        return { handled: true, result: await this.chatSwarmCompat.create(args || {}) };
      case 'chat_swarm_join':
        return { handled: true, result: await this.chatSwarmCompat.join(args || {}) };
      case 'chat_swarm_dock': {
        const status = await this.chatSwarmCompat.status(args.workerToken);
        await this.chatSwarmCompat.setDockOnline(args.workerToken, true);
        return {
          handled: true,
          result: {
            ok: true,
            swarmId: status.swarmId,
            workerId: status.workerId,
            workerToken: args.workerToken,
            dockStreamUrl: `${this.baseUrl}/chat-swarm/worker-events`,
            workerDock: true
          }
        };
      }
      case 'chat_swarm_join_browser': {
        const joined = await this.chatSwarmCompat.join(args || {});
        const binding = await this.chatSwarmCompat.enableBrowserWake(joined.workerToken);
        return {
          handled: true,
          result: {
            ...joined,
            browserBindCode: binding.bindCode,
            browserBindExpiresAt: binding.expiresAt,
            marker: `[[CHAT_SWARM_BIND:${binding.bindCode}]]`,
            browserMode: true
          }
        };
      }
      case 'chat_swarm_status':
        return { handled: true, result: await this.chatSwarmCompat.status(args.token) };
      case 'chat_swarm_resize':
        return { handled: true, result: await this.chatSwarmCompat.resize(args) };
      case 'chat_swarm_dispatch':
        return { handled: true, result: await this.chatSwarmCompat.dispatch(args) };
      case 'chat_swarm_claim':
        return { handled: true, result: await this.chatSwarmCompat.next({ workerToken: args.workerToken, waitMs: 0 }) };
      case 'chat_swarm_ack':
        return { handled: true, result: await this.chatSwarmCompat.acknowledge(args) };
      case 'chat_swarm_next':
        return {
          handled: true,
          result: await this.chatSwarmCompat.next({ workerToken: args.workerToken, waitMs: args.waitMs ?? SWARM_CHECKPOINT_WAIT_MS })
        };
      case 'chat_swarm_recover':
        return {
          handled: true,
          result: await this.chatSwarmCompat.next({ workerToken: args.workerToken, waitMs: Math.min(args.waitMs ?? SWARM_CHECKPOINT_WAIT_MS, SWARM_CHECKPOINT_WAIT_MS) })
        };
      case 'chat_swarm_submit_once':
        return { handled: true, result: await this.chatSwarmCompat.submit({ ...args, waitForNextMs: 0 }) };
      case 'chat_swarm_submit':
        return { handled: true, result: await this.chatSwarmCompat.submit({ ...args, waitForNextMs: SWARM_CHECKPOINT_WAIT_MS }) };
      case 'chat_swarm_collect':
        return { handled: true, result: await this.chatSwarmCompat.collect(args) };
      case 'chat_swarm_cancel':
        return { handled: true, result: await this.chatSwarmCompat.cancel(args) };
      case 'chat_swarm_recycle_worker':
        return { handled: true, result: await this.chatSwarmCompat.recycleWorker(args) };
      case 'chat_swarm_leave':
        return { handled: true, result: await this.chatSwarmCompat.leave(args.workerToken) };
      case 'chat_swarm_close':
        return { handled: true, result: await this.chatSwarmCompat.close(args) };
      case 'chat_swarm_wake_bridge':
        return {
          handled: true,
          result: {
            ok: true,
            wakeBridge: 'cloudflare-durable-object',
            baseUrl: this.baseUrl,
            bindUrl: `${this.baseUrl}/chat-swarm/browser-bind`,
            directJoinUrl: `${this.baseUrl}/chat-swarm/browser-direct-join`,
            claimUrl: `${this.baseUrl}/chat-swarm/browser-claim`,
            eventsUrl: `${this.baseUrl}/chat-swarm/browser-events`,
            workerEventsUrl: `${this.baseUrl}/chat-swarm/worker-events`
          }
        };
      case 'chat_swarm_runtime_status':
        return { handled: false };
      default:
        return { handled: false };
    }
  }

  private async processSingleMcpItem(body: any, auth: TokenPayload, modern: boolean, protocolVersion: string): Promise<Response> {
    const method = body?.method;
    const params = body?.params || {};
    const id = body?.id !== undefined ? body.id : null;
    const jsonrpc = body?.jsonrpc || '2.0';
    const headers = mcpResponseHeaders(modern, protocolVersion);
    const caller: McpCallerContext = { scopes: auth.scopes, subjectId: auth.subjectId };
    const wrap = <T extends Record<string, any>>(value: T) => modern ? modernResult(value) : value;
    const wrapList = <T extends Record<string, any>>(value: T) => modern
      ? modernCacheableResult(value, { ttlMs: 300000, cacheScope: 'private' })
      : value;

    if (method === 'server/discover') {
      if (!modern) {
        return Response.json(
          { jsonrpc, id, error: { code: -32601, message: 'server/discover requires MCP 2026-07-28' } },
          { status: 404, headers }
        );
      }
      return Response.json({
        jsonrpc,
        id,
        result: modernCacheableResult({
          supportedVersions: [...MCP_SUPPORTED_MODERN_VERSIONS],
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false }
          },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'DevSpace Ultra vNext', version: '2.0.1' }
          },
          instructions: 'Secure DevSpace Ultra gateway for durable remote tasks, Kaggle compute, local agents and Chat Swarm.'
        }, { ttlMs: 300000, cacheScope: 'private' })
      }, { headers });
    }

    if (method === 'initialize') {
      if (modern) {
        return Response.json(
          { jsonrpc, id, error: { code: -32601, message: 'initialize is not part of MCP 2026-07-28 stateless transport; use server/discover' } },
          { status: 404, headers }
        );
      }
      return Response.json({
        jsonrpc,
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: { name: 'DevSpace Ultra vNext', version: '2.0.1' }
        }
      }, { headers });
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return new Response(null, { status: 204, headers });
    }
    if (method === 'ping') return Response.json({ jsonrpc, id, result: wrap({}) }, { headers });
    if (method === 'tools/list') return Response.json({ jsonrpc, id, result: wrapList({ tools: this.getToolsList() }) }, { headers });
    if (method === 'resources/list') return Response.json({ jsonrpc, id, result: wrapList({ resources: [] }) }, { headers });
    if (method === 'prompts/list') return Response.json({ jsonrpc, id, result: wrapList({ prompts: [] }) }, { headers });

    if (method === 'tools/call') {
      try {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const legacy = await this.callLegacyChatSwarmTool(toolName, args, auth);
        let result: any;

        if (legacy.handled) {
          result = legacy.result;
        } else {
          switch (toolName) {
            case 'remote_task_submit': result = await this.mcpHandlers.handleRemoteTaskSubmit(args, caller); break;
            case 'remote_task_status': result = await this.mcpHandlers.handleRemoteTaskStatus(args, caller); break;
            case 'remote_task_logs': result = await this.mcpHandlers.handleRemoteTaskLogs(args, caller); break;
            case 'remote_task_artifacts': result = await this.mcpHandlers.handleRemoteTaskArtifacts(args, caller); break;
            case 'remote_task_cancel': result = await this.mcpHandlers.handleRemoteTaskCancel(args, caller); break;
            case 'kaggle_run': result = await this.mcpHandlers.handleKaggleRun(args, caller); break;
            case 'kaggle_status': result = await this.mcpHandlers.handleKaggleStatus(args, caller); break;
            case 'kaggle_logs': result = await this.mcpHandlers.handleKaggleLogs(args, caller); break;
            case 'kaggle_result': result = await this.mcpHandlers.handleKaggleResult(args, caller); break;
            case 'swarm_dispatch': result = await this.mcpHandlers.handleSwarmDispatch(args, caller); break;
            case 'swarm_status': result = await this.mcpHandlers.handleSwarmStatus(caller); break;
            case 'chat_swarm_runtime_status': result = await this.mcpHandlers.handleChatSwarmRuntimeStatus(caller); break;
            case 'device_status': result = await this.mcpHandlers.handleDeviceStatus(caller); break;
            case 'kill_switch_trigger': result = await this.mcpHandlers.handleKillSwitchTrigger(args, caller); break;
            default:
              return Response.json(
                { jsonrpc, id, error: { code: -32601, message: `Tool '${toolName}' not found` } },
                { status: 404, headers }
              );
          }
        }

        return Response.json({
          jsonrpc,
          id,
          result: wrap({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
        }, { headers });
      } catch (err: any) {
        return Response.json({
          jsonrpc,
          id,
          result: wrap({
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }]
          })
        }, { headers });
      }
    }

    return Response.json(
      { jsonrpc, id, error: { code: -32601, message: `Method '${method}' not found` } },
      { status: modern ? 404 : 400, headers }
    );
  }
}
