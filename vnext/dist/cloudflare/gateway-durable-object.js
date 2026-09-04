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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GatewayDurableObject = void 0;
const sqlite_storage_adapter_1 = require("./sqlite-storage-adapter");
const r2_artifact_storage_1 = require("./r2-artifact-storage");
const r2_usage_guard_1 = require("./r2-usage-guard");
const http_client_1 = require("../kaggle/http-client");
const auth_manager_1 = require("../security/auth-manager");
const scope_checker_1 = require("../security/scope-checker");
const capabilities_1 = require("../local-agent/capabilities");
const kill_switch_1 = require("../security/kill-switch");
const rate_limiter_1 = require("../security/rate-limiter");
const audit_logger_1 = require("../security/audit-logger");
const task_store_1 = require("../storage/task-store");
const artifact_store_1 = require("../storage/artifact-store");
const idempotency_store_1 = require("../storage/idempotency-store");
const task_router_1 = require("../gateway/task-router");
const backend_1 = require("../kaggle/backend");
const swarm_orchestrator_1 = require("../swarm/swarm-orchestrator");
const chat_swarm_compat_1 = require("../swarm/chat-swarm-compat");
const handlers_1 = require("../mcp/handlers");
const tools = __importStar(require("../mcp/tools"));
const oauth_manager_1 = require("../oauth/oauth-manager");
const protocol_1 = require("../mcp/protocol");
const DEFAULT_PUBLIC_BASE_URL = 'https://devspace-ultra-gateway.abdul-hsu.workers.dev';
const KAGGLE_POLLS_STORAGE_KEY = 'devspace:kaggle-polls:v1';
const DEFAULT_KAGGLE_POLL_MS = 15000;
const SWARM_EVENT_POLL_MS = 1500;
const SWARM_CHECKPOINT_WAIT_MS = 25000;
class GatewayDurableObject {
    ctx;
    env;
    storage;
    r2Storage;
    kaggleHttpClient;
    authManager;
    oauthManager;
    killSwitch;
    rateLimiter;
    auditLogger;
    taskStore;
    artifactStore;
    idempotencyStore;
    kaggleBackend;
    swarmOrchestrator;
    chatSwarmCompat;
    taskRouter;
    mcpHandlers;
    ready;
    baseUrl;
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        if (!env.MASTER_SECRET || env.MASTER_SECRET.length < 32) {
            throw new Error('MASTER_SECRET is required in Cloudflare and must be at least 32 characters; refusing ephemeral token signing keys');
        }
        this.baseUrl = (env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
        this.storage = new sqlite_storage_adapter_1.CloudflareSqliteStorageAdapter(ctx.storage.sql);
        const r2Guard = new r2_usage_guard_1.R2UsageGuard(this.storage, {
            maxTotalStoredBytes: env.R2_MAX_TOTAL_BYTES ? Number(env.R2_MAX_TOTAL_BYTES) : undefined,
            maxSingleArtifactBytes: env.R2_MAX_OBJECT_BYTES ? Number(env.R2_MAX_OBJECT_BYTES) : undefined,
            maxLiveObjectCount: env.R2_MAX_OBJECT_COUNT ? Number(env.R2_MAX_OBJECT_COUNT) : undefined,
            maxClassAOperationsMonth: env.R2_MAX_CLASS_A_MONTH ? Number(env.R2_MAX_CLASS_A_MONTH) : undefined,
            maxClassBOperationsMonth: env.R2_MAX_CLASS_B_MONTH ? Number(env.R2_MAX_CLASS_B_MONTH) : undefined,
            retentionDays: env.R2_RETENTION_DAYS ? Number(env.R2_RETENTION_DAYS) : undefined
        });
        this.r2Storage = new r2_artifact_storage_1.CloudflareR2ArtifactStorage(env.ARTIFACTS_R2, r2Guard);
        let kaggleUser = env.KAGGLE_USERNAME;
        let kaggleKey = env.KAGGLE_KEY;
        if (env.KAGGLE_API_TOKEN && (!kaggleUser || !kaggleKey)) {
            try {
                const parsed = JSON.parse(env.KAGGLE_API_TOKEN);
                kaggleUser = parsed.username;
                kaggleKey = parsed.key;
            }
            catch { }
        }
        this.kaggleHttpClient = new http_client_1.CloudflareKaggleHttpClient({
            username: kaggleUser,
            key: kaggleKey,
            isMockMode: !kaggleUser || !kaggleKey
        });
        this.authManager = new auth_manager_1.AuthManager(env.MASTER_SECRET);
        this.oauthManager = new oauth_manager_1.OAuthManager(this.baseUrl, this.authManager, this.storage);
        this.killSwitch = new kill_switch_1.KillSwitch(this.storage);
        this.rateLimiter = new rate_limiter_1.RateLimiter();
        this.auditLogger = new audit_logger_1.AuditLogger(undefined, this.storage);
        this.taskStore = new task_store_1.TaskStore(undefined, 60000, this.storage);
        this.idempotencyStore = new idempotency_store_1.IdempotencyStore(undefined, 24 * 3600 * 1000, this.storage);
        this.chatSwarmCompat = new chat_swarm_compat_1.DurableChatSwarmCompat(ctx.storage);
        const persistArtifactPayload = async (meta, bytes) => {
            const pending = this.r2Storage.saveArtifactPayload(meta, bytes);
            if (typeof this.ctx.waitUntil === 'function')
                this.ctx.waitUntil(pending);
            await pending;
        };
        this.artifactStore = new artifact_store_1.ArtifactStore(undefined, 50 * 1024 * 1024, this.storage, persistArtifactPayload);
        this.kaggleBackend = new backend_1.KaggleBackend(this.taskStore, this.artifactStore, this.kaggleHttpClient, undefined, DEFAULT_KAGGLE_POLL_MS, { schedule: (taskId, kernelSlug, delayMs) => this.scheduleKagglePoll(taskId, kernelSlug, delayMs) });
        this.swarmOrchestrator = new swarm_orchestrator_1.SwarmOrchestrator(this.taskStore);
        this.taskRouter = new task_router_1.TaskRouter(this.taskStore, this.idempotencyStore, this.kaggleBackend, this.swarmOrchestrator, this.killSwitch, this.auditLogger);
        const gatewayFacade = {
            taskRouter: this.taskRouter,
            taskStore: this.taskStore,
            artifactStore: this.artifactStore,
            kaggleBackend: this.kaggleBackend,
            swarmOrchestrator: this.swarmOrchestrator,
            authManager: this.authManager,
            killSwitch: this.killSwitch,
            connectionManager: {
                getConnectedAgents: () => (this.ctx.getWebSockets ? this.ctx.getWebSockets() : []).map((ws) => {
                    const att = (typeof ws.deserializeAttachment === 'function' ? ws.deserializeAttachment() : null) || {};
                    return {
                        deviceId: att.deviceId || 'unknown',
                        name: att.name || att.deviceId || 'unknown',
                        platform: att.platform || 'windows',
                        capabilities: att.capabilities || [],
                        connectedAt: att.connectedAt || Date.now(),
                        lastHeartbeatAt: Date.now(),
                        socket: ws
                    };
                }).filter((a) => a.deviceId !== 'unknown')
            }
        };
        this.mcpHandlers = new handlers_1.McpHandlers(gatewayFacade);
        this.ready = this.initializeFromDurableStorage();
        if (typeof this.ctx.blockConcurrencyWhile === 'function') {
            this.ctx.blockConcurrencyWhile(() => this.ready);
        }
    }
    async initializeFromDurableStorage() {
        try {
            await this.killSwitch.hydrate();
        }
        catch (err) {
            console.error('Failed to hydrate durable kill switch state:', err);
        }
        try {
            await this.r2Storage.getGuard()?.hydrate();
        }
        catch (err) {
            console.error('Failed to hydrate R2 usage guard:', err);
        }
        try {
            this.taskStore.hydrate(await this.storage.listTasks());
            this.taskStore.recoverStaleTasks();
            this.kaggleBackend.reconcileDanglingTasks().catch(err => console.warn('[DO] Background Kaggle reconciliation warning:', err));
        }
        catch (err) {
            console.error('Failed to hydrate durable task state:', err);
        }
        try {
            this.artifactStore.hydrate(await this.storage.listArtifacts());
        }
        catch (err) {
            console.error('Failed to hydrate artifact metadata:', err);
        }
        try {
            await this.rearmKaggleAlarm();
        }
        catch (err) {
            console.error('Failed to rearm durable Kaggle poll alarm:', err);
        }
    }
    async readPendingKagglePolls() {
        if (typeof this.ctx.storage?.get !== 'function')
            return {};
        const stored = await this.ctx.storage.get(KAGGLE_POLLS_STORAGE_KEY);
        if (!stored)
            return {};
        if (typeof stored === 'string') {
            try {
                return JSON.parse(stored);
            }
            catch {
                return {};
            }
        }
        return stored;
    }
    async writePendingKagglePolls(polls) {
        if (typeof this.ctx.storage?.put !== 'function')
            return;
        await this.ctx.storage.put(KAGGLE_POLLS_STORAGE_KEY, polls);
    }
    async scheduleKagglePoll(taskId, kernelSlug, delayMs = DEFAULT_KAGGLE_POLL_MS) {
        if (typeof this.ctx.storage?.put !== 'function' || typeof this.ctx.storage?.setAlarm !== 'function')
            return;
        const polls = await this.readPendingKagglePolls();
        polls[taskId] = { taskId, kernelSlug, dueAt: Date.now() + Math.max(1000, delayMs) };
        await this.writePendingKagglePolls(polls);
        await this.rearmKaggleAlarm(polls);
    }
    async rearmKaggleAlarm(polls) {
        if (typeof this.ctx.storage?.setAlarm !== 'function')
            return;
        const current = polls || await this.readPendingKagglePolls();
        const entries = Object.values(current);
        if (entries.length === 0) {
            if (typeof this.ctx.storage?.deleteAlarm === 'function')
                await this.ctx.storage.deleteAlarm();
            return;
        }
        const earliest = Math.min(...entries.map(item => item.dueAt));
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, earliest));
    }
    async alarm() {
        await this.ready;
        const polls = await this.readPendingKagglePolls();
        const now = Date.now();
        const due = Object.values(polls).filter(item => item.dueAt <= now + 250);
        for (const item of due) {
            try {
                const stillRunning = await this.kaggleBackend.pollKaggleTask(item.taskId, item.kernelSlug, false);
                if (stillRunning) {
                    polls[item.taskId] = { ...item, dueAt: Date.now() + DEFAULT_KAGGLE_POLL_MS };
                }
                else {
                    delete polls[item.taskId];
                }
            }
            catch (err) {
                console.error(`Durable Kaggle poll failed for ${item.taskId}:`, err?.message || String(err));
                polls[item.taskId] = { ...item, dueAt: Date.now() + DEFAULT_KAGGLE_POLL_MS };
            }
        }
        await this.writePendingKagglePolls(polls);
        await this.rearmKaggleAlarm(polls);
    }
    corsHeaders() {
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, WWW-Authenticate, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-Chat-Swarm-Browser-Token, X-Chat-Swarm-Worker-Token, X-Admin-Secret, X-DevSpace-Admin-Secret',
            'Access-Control-Expose-Headers': 'MCP-Protocol-Version, WWW-Authenticate',
            'Access-Control-Max-Age': '86400'
        };
    }
    timingSafeEqualStr(a, b) {
        if (typeof a !== 'string' || typeof b !== 'string')
            return false;
        const bufA = new TextEncoder().encode(a);
        const bufB = new TextEncoder().encode(b);
        if (bufA.length !== bufB.length)
            return false;
        let diff = 0;
        for (let i = 0; i < bufA.length; i++) {
            diff |= bufA[i] ^ bufB[i];
        }
        return diff === 0;
    }
    authenticateAdmin(request) {
        const adminSecret = this.env.ADMIN_SECRET;
        if (!adminSecret || adminSecret.length < 16) {
            return Response.json({ error: 'ADMIN_NOT_CONFIGURED', message: 'ADMIN_SECRET is not configured on this gateway' }, { status: 503, headers: this.corsHeaders() });
        }
        const headerSecret = request.headers.get('X-Admin-Secret') || request.headers.get('X-DevSpace-Admin-Secret');
        const authHeader = request.headers.get('Authorization');
        const bearerSecret = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
        const candidate = headerSecret || bearerSecret;
        if (!candidate) {
            return Response.json({ error: 'AUTH_REQUIRED', message: 'Admin credential required (X-Admin-Secret header)' }, { status: 401, headers: this.corsHeaders() });
        }
        // Explicitly reject token-signing master secret when used as admin credential
        if (this.env.MASTER_SECRET && this.timingSafeEqualStr(candidate, this.env.MASTER_SECRET)) {
            return Response.json({ error: 'FORBIDDEN: token signing master secret cannot be used as admin credential' }, { status: 403, headers: this.corsHeaders() });
        }
        if (!this.timingSafeEqualStr(candidate, adminSecret)) {
            return Response.json({ error: 'AUTH_INVALID', message: 'Invalid admin credential' }, { status: 401, headers: this.corsHeaders() });
        }
        return undefined; // Authorized!
    }
    async parseJsonRequest(request) {
        try {
            return await request.json();
        }
        catch {
            throw new Error('Invalid JSON request body.');
        }
    }
    browserBridgeError(error, status = 401) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status, headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' } });
    }
    eventStream(eventSource, onCancel) {
        const encoder = new TextEncoder();
        let timer;
        let closed = false;
        let running = false;
        let lastSerialized = '';
        let lastSentAt = 0;
        const stream = new ReadableStream({
            start(controller) {
                const stop = () => {
                    if (closed)
                        return;
                    closed = true;
                    if (timer)
                        clearInterval(timer);
                    try {
                        controller.close();
                    }
                    catch { }
                };
                const emit = async () => {
                    if (closed || running)
                        return;
                    running = true;
                    try {
                        const event = await eventSource();
                        const serialized = JSON.stringify(event);
                        const now = Date.now();
                        if (serialized !== lastSerialized || now - lastSentAt >= 15000) {
                            controller.enqueue(encoder.encode(`data: ${serialized}\n\n`));
                            lastSerialized = serialized;
                            lastSentAt = now;
                        }
                        else {
                            controller.enqueue(encoder.encode(': keepalive\n\n'));
                        }
                        if (event.type === 'closed')
                            stop();
                    }
                    catch {
                        try {
                            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'bridge_state_unavailable' })}\n\n`));
                        }
                        catch { }
                        stop();
                    }
                    finally {
                        running = false;
                    }
                };
                void emit();
                timer = setInterval(() => void emit(), SWARM_EVENT_POLL_MS);
            },
            cancel() {
                closed = true;
                if (timer)
                    clearInterval(timer);
                if (onCancel)
                    void onCancel();
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
    async handleBrowserBridge(request, url) {
        if (url.pathname === '/chat-swarm/browser-bind' && request.method === 'POST') {
            try {
                const body = await this.parseJsonRequest(request);
                return Response.json(await this.chatSwarmCompat.bindBrowser(body?.code), {
                    headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
                });
            }
            catch (err) {
                return this.browserBridgeError(err);
            }
        }
        if (url.pathname === '/chat-swarm/browser-bind-invite' && request.method === 'POST') {
            try {
                const body = await this.parseJsonRequest(request);
                return Response.json(await this.chatSwarmCompat.bindBrowserByInvite(body?.inviteCode), {
                    headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
                });
            }
            catch (err) {
                return this.browserBridgeError(err);
            }
        }
        if (url.pathname === '/chat-swarm/browser-direct-join' && request.method === 'POST') {
            try {
                const body = await this.parseJsonRequest(request);
                if (!body?.pageKey)
                    throw new Error('Browser page key is required.');
                return Response.json(await this.chatSwarmCompat.joinBrowserDirect({
                    inviteCode: body?.inviteCode,
                    label: body?.label,
                    pageKey: body.pageKey
                }), {
                    headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
                });
            }
            catch (err) {
                return this.browserBridgeError(err, 409);
            }
        }
        if (url.pathname === '/chat-swarm/browser-claim' && request.method === 'POST') {
            const token = request.headers.get('X-Chat-Swarm-Browser-Token') || '';
            if (!token)
                return this.browserBridgeError(new Error('Browser wake token is required.'));
            try {
                return Response.json(await this.chatSwarmCompat.browserClaim(token), {
                    headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' }
                });
            }
            catch (err) {
                return this.browserBridgeError(err);
            }
        }
        if (url.pathname === '/chat-swarm/browser-events' && request.method === 'GET') {
            const token = request.headers.get('X-Chat-Swarm-Browser-Token') || '';
            if (!token)
                return this.browserBridgeError(new Error('Browser wake token is required.'));
            try {
                await this.chatSwarmCompat.browserEvent(token);
            }
            catch (err) {
                return this.browserBridgeError(err);
            }
            return this.eventStream(() => this.chatSwarmCompat.browserEvent(token), () => this.chatSwarmCompat.setBrowserOnline(token, false).catch(() => undefined));
        }
        if (url.pathname === '/chat-swarm/worker-events' && request.method === 'GET') {
            const token = request.headers.get('X-Chat-Swarm-Worker-Token') || '';
            if (!token)
                return this.browserBridgeError(new Error('Worker token is required.'));
            try {
                await this.chatSwarmCompat.workerEvent(token);
            }
            catch (err) {
                return this.browserBridgeError(err);
            }
            return this.eventStream(() => this.chatSwarmCompat.workerEvent(token), () => this.chatSwarmCompat.setDockOnline(token, false).catch(() => undefined));
        }
        return undefined;
    }
    async fetch(request) {
        try {
            await this.ready;
            const url = new URL(request.url);
            if (url.pathname === '/ws/agent') {
                if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
                    return new Response('Expected WebSocket upgrade', { status: 426 });
                }
                const pair = new globalThis.WebSocketPair();
                const [client, server] = [pair[0], pair[1]];
                this.ctx.acceptWebSocket(server);
                return new Response(null, { status: 101, webSocket: client });
            }
            if (request.method === 'OPTIONS')
                return new Response(null, { status: 204, headers: this.corsHeaders() });
            const browserBridgeResponse = await this.handleBrowserBridge(request, url);
            if (browserBridgeResponse)
                return browserBridgeResponse;
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
                }
                catch (err) {
                    return Response.json({ error: 'invalid_client_metadata', error_description: err.message }, { status: 400, headers: this.corsHeaders() });
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
                    const params = {};
                    if (contentType.includes('application/x-www-form-urlencoded')) {
                        const form = new URLSearchParams(await request.text());
                        for (const [k, v] of form.entries())
                            params[k] = v;
                    }
                    else {
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
                }
                catch (err) {
                    return Response.json({ error: 'invalid_request', error_description: err.message }, { status: 400, headers: this.corsHeaders() });
                }
            }
            if (url.pathname === '/oauth/token' && request.method === 'POST') {
                const params = {};
                try {
                    const contentType = request.headers.get('Content-Type') || '';
                    if (contentType.includes('application/x-www-form-urlencoded')) {
                        const form = new URLSearchParams(await request.text());
                        for (const [k, v] of form.entries())
                            params[k] = v;
                    }
                    else {
                        Object.assign(params, await request.json());
                    }
                }
                catch {
                    return Response.json({ error: 'invalid_request', error_description: 'Unable to parse token request' }, { status: 400, headers: this.corsHeaders() });
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
                }
                catch (err) {
                    const error = err.message?.startsWith('INVALID_TARGET')
                        ? 'invalid_target'
                        : err.message?.startsWith('INVALID_REQUEST')
                            ? 'invalid_request'
                            : 'invalid_grant';
                    return Response.json({ error, error_description: err.message }, { status: 400, headers: { ...this.corsHeaders(), 'Cache-Control': 'no-store' } });
                }
            }
            if (url.pathname === '/health' && request.method === 'GET') {
                return Response.json({ ok: true });
            }
            if ((url.pathname === '/admin/health' || url.pathname === '/api/admin/health') && request.method === 'GET') {
                const adminAuthError = this.authenticateAdmin(request);
                if (adminAuthError)
                    return adminAuthError;
                const r2GuardState = this.r2Storage.getGuard()?.getState();
                const r2Limits = this.r2Storage.getGuard()?.getLimits();
                return Response.json({
                    status: 'healthy',
                    service: 'devspace-ultra-cloudflare-gateway',
                    runtime: 'cloudflare-durable-objects-sqlite',
                    r2Available: !!this.env.ARTIFACTS_R2,
                    r2Usage: r2GuardState ? {
                        monthKey: r2GuardState.monthKey,
                        storedBytes: r2GuardState.storedBytes,
                        objectCount: r2GuardState.objectCount,
                        classAOperations: r2GuardState.classAOperations,
                        classBOperations: r2GuardState.classBOperations
                    } : undefined,
                    r2Limits: r2Limits ? {
                        maxTotalStoredBytes: r2Limits.maxTotalStoredBytes,
                        maxSingleArtifactBytes: r2Limits.maxSingleArtifactBytes,
                        maxLiveObjectCount: r2Limits.maxLiveObjectCount,
                        maxClassAOperationsMonth: r2Limits.maxClassAOperationsMonth,
                        maxClassBOperationsMonth: r2Limits.maxClassBOperationsMonth,
                        retentionDays: r2Limits.retentionDays
                    } : undefined,
                    kaggleConfigured: this.kaggleHttpClient.hasCredentials(),
                    version: '2.0.1',
                    connectedAgents: this.ctx.getWebSockets().length,
                    killSwitch: this.killSwitch.getState().globalEmergencyStop ? 'EMERGENCY_STOP' : 'ACTIVE'
                });
            }
            if ((url.pathname === '/admin/kill-switch' || url.pathname === '/api/admin/kill-switch') && request.method === 'GET') {
                const adminAuthError = this.authenticateAdmin(request);
                if (adminAuthError)
                    return adminAuthError;
                return Response.json({ state: this.killSwitch.getState() });
            }
            if ((url.pathname === '/admin/kill-switch' || url.pathname === '/api/admin/kill-switch') && request.method === 'POST') {
                const adminAuthError = this.authenticateAdmin(request);
                if (adminAuthError)
                    return adminAuthError;
                const body = await request.json();
                const action = body.action || '';
                const reason = body.reason || 'Admin action';
                const targetId = body.targetId || '';
                if (action === 'EMERGENCY_STOP') {
                    await this.killSwitch.triggerGlobalEmergencyStop(reason);
                }
                else if (action === 'CLEAR_STOP') {
                    await this.killSwitch.resetGlobalEmergencyStop();
                }
                else if (action === 'REVOKE_DEVICE' && targetId) {
                    await this.killSwitch.revokeDevice(targetId, reason);
                }
                else if (action === 'REVOKE_CLIENT' && targetId) {
                    await this.killSwitch.revokeClient(targetId, reason);
                }
                else if (action === 'DISABLE_LOCAL') {
                    await this.killSwitch.setLocalAgentExecutionDisabled(true);
                }
                else if (action === 'ENABLE_LOCAL') {
                    await this.killSwitch.setLocalAgentExecutionDisabled(false);
                }
                else if (action === 'DISABLE_KAGGLE') {
                    await this.killSwitch.setKaggleExecutionDisabled(true);
                }
                else if (action === 'ENABLE_KAGGLE') {
                    await this.killSwitch.setKaggleExecutionDisabled(false);
                }
                else if (action === 'DISABLE_SWARM') {
                    await this.killSwitch.setSwarmExecutionDisabled(true);
                }
                else if (action === 'ENABLE_SWARM') {
                    await this.killSwitch.setSwarmExecutionDisabled(false);
                }
                else {
                    return Response.json({ error: 'INVALID_ACTION', action }, { status: 400 });
                }
                return Response.json({ ok: true, action, state: this.killSwitch.getState() });
            }
            if ((url.pathname === '/admin/tasks' || url.pathname === '/api/admin/tasks') && request.method === 'GET') {
                const adminAuthError = this.authenticateAdmin(request);
                if (adminAuthError)
                    return adminAuthError;
                const tasks = await this.storage.listTasks({ limit: 100 });
                return Response.json({
                    total: tasks.length,
                    tasks: tasks.map(t => ({
                        taskId: t.taskId,
                        backend: t.backend,
                        capability: t.capability,
                        status: t.status,
                        createdAt: t.createdAt,
                        startedAt: t.startedAt,
                        completedAt: t.completedAt,
                        clientRequestId: t.clientRequestId,
                        kernelSlug: t.payload?.kernelSlug,
                        codeSize: t.payload?.code ? (typeof t.payload.code === 'string' ? t.payload.code.length : JSON.stringify(t.payload.code).length) : undefined
                    }))
                });
            }
            if ((url.pathname === '/mcp' || url.pathname === '/api/mcp/v1') && request.method === 'GET') {
                if (request.headers.get('MCP-Protocol-Version') === protocol_1.MCP_2026_VERSION) {
                    return new Response(null, {
                        status: 405,
                        headers: { ...this.corsHeaders(), 'Allow': 'POST', 'MCP-Protocol-Version': protocol_1.MCP_2026_VERSION }
                    });
                }
                const auth = await this.authenticate(request, true);
                if (auth.error)
                    return auth.error;
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
                if (auth.error)
                    return auth.error;
                let body;
                try {
                    const text = await request.text();
                    body = text ? JSON.parse(text) : {};
                }
                catch {
                    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400, headers: this.corsHeaders() });
                }
                if (Array.isArray(body)) {
                    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC batches are not supported by this endpoint' } }, { status: 400, headers: this.corsHeaders() });
                }
                const validation = (0, protocol_1.validateMcpRequest)(request.headers, body);
                if ('status' in validation) {
                    return Response.json(validation.body, { status: validation.status, headers: this.corsHeaders() });
                }
                return this.processSingleMcpItem(body, auth.payload, validation.modern, validation.protocolVersion);
            }
            if (url.pathname === '/api/tasks' && request.method === 'POST') {
                const auth = await this.authenticate(request);
                if (auth.error)
                    return auth.error;
                const body = await request.json();
                try {
                    const result = await this.taskRouter.routeTaskSubmit(body, auth.payload.scopes, auth.payload.subjectId);
                    return Response.json(result, { status: 202 });
                }
                catch (err) {
                    if (err.message?.includes('AUTH_FORBIDDEN')) {
                        return Response.json({ error: err.message }, { status: 403 });
                    }
                    if (err.message?.startsWith('INVALID_') ||
                        err.message?.startsWith('EMERGENCY_') ||
                        err.message?.startsWith('KILL_SWITCH_') ||
                        err.message?.includes('EMERGENCY_DENY_ALL') ||
                        err.message?.startsWith('UNKNOWN_') ||
                        err.message?.startsWith('UNSUPPORTED_') ||
                        err.message?.startsWith('SCOPE_') ||
                        err.message?.startsWith('R2_USAGE_LIMIT_EXCEEDED')) {
                        return Response.json({ error: err.message }, { status: 400 });
                    }
                    throw err;
                }
            }
            if (url.pathname.startsWith('/api/tasks/') && request.method === 'GET') {
                const auth = await this.authenticate(request);
                if (auth.error)
                    return auth.error;
                if (!scope_checker_1.ScopeChecker.hasScope(auth.payload.scopes, 'tasks:read')) {
                    return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
                }
                const taskId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length));
                const task = this.taskStore.getTask(taskId);
                return task ? Response.json(task) : Response.json({ error: 'TASK_NOT_FOUND' }, { status: 404 });
            }
            if (url.pathname.startsWith('/api/artifacts/') && request.method === 'GET') {
                const auth = await this.authenticate(request);
                if (auth.error)
                    return auth.error;
                if (!scope_checker_1.ScopeChecker.hasScope(auth.payload.scopes, 'artifacts:read') && !scope_checker_1.ScopeChecker.hasScope(auth.payload.scopes, 'tasks:read')) {
                    return Response.json({ error: 'FORBIDDEN' }, { status: 403 });
                }
                const artifactId = decodeURIComponent(url.pathname.slice('/api/artifacts/'.length));
                const meta = this.artifactStore.getArtifactMetadata(artifactId) || await this.storage.getArtifactMetadata(artifactId);
                if (!meta)
                    return Response.json({ error: 'ARTIFACT_NOT_FOUND' }, { status: 404 });
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
        }
        catch (err) {
            console.error('Unhandled exception in GatewayDurableObject fetch:', err);
            return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
        }
    }
    async webSocketMessage(ws, message) {
        await this.ready;
        try {
            const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
            const msg = JSON.parse(text);
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
                    : [...capabilities_1.LOCAL_EXECUTABLE_CAPABILITIES];
                const authorizedCaps = requestedCaps.filter(cap => {
                    if (!(0, capabilities_1.isLocalExecutableCapability)(cap))
                        return false;
                    const requiredScope = scope_checker_1.ScopeChecker.getRequiredScopeForCapability(cap);
                    return scope_checker_1.ScopeChecker.hasScope(val.payload.scopes, requiredScope);
                });
                this.authManager.rememberAuthenticatedDevice(msg.token, authoritativeDeviceId, msg.name || authoritativeDeviceId, authorizedCaps, msg.platform || 'windows');
                ws.serializeAttachment({
                    deviceId: authoritativeDeviceId,
                    name: msg.name || authoritativeDeviceId,
                    platform: msg.platform || 'windows',
                    capabilities: authorizedCaps,
                    connectedAt: Date.now()
                });
                ws.send(JSON.stringify({
                    type: 'AGENT_REGISTERED',
                    messageId: msg.messageId || crypto.randomUUID(),
                    timestamp: Date.now(),
                    deviceId: authoritativeDeviceId
                }));
                return;
            }
            const attachment = ws.deserializeAttachment();
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
                    messageId: msg.messageId || crypto.randomUUID(),
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
                        messageId: msg.messageId || crypto.randomUUID(),
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
                this.taskStore.failTask(msg.taskId, msg.error, { retryable: msg.retryable ?? false });
                return;
            }
        }
        catch (err) {
            console.error('Error handling WebSocket message in Durable Object:', err);
        }
    }
    async webSocketClose(_ws, _code, _reason) { }
    async authenticate(request, requireMcpAccess = false) {
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
                error: Response.json({ error: 'AUTH_INVALID', message: 'Access token is bound to a different resource' }, { status: 401, headers: this.corsHeaders() })
            };
        }
        if (this.authManager.isTokenRevoked(payload.tokenId) || await this.storage.isTokenRevoked(payload.tokenId)) {
            return {
                error: Response.json({ error: 'TOKEN_REVOKED' }, { status: 401, headers: { ...this.corsHeaders(), 'WWW-Authenticate': 'Bearer error="invalid_token"' } })
            };
        }
        if (requireMcpAccess && !scope_checker_1.ScopeChecker.hasScope(payload.scopes, 'mcp:access')) {
            return {
                error: Response.json({ error: 'AUTH_FORBIDDEN', message: 'mcp:access scope required' }, { status: 403, headers: this.corsHeaders() })
            };
        }
        return { payload };
    }
    getToolsList() {
        return tools.getCanonicalToolsList();
    }
    requireSwarmScope(auth) {
        if (!scope_checker_1.ScopeChecker.hasScope(auth.scopes, 'swarm:dispatch')) {
            throw new Error('AUTH_FORBIDDEN: swarm:dispatch scope required');
        }
    }
    async callLegacyChatSwarmTool(toolName, args, auth) {
        if (!toolName.startsWith('chat_swarm_'))
            return { handled: false };
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
    async processSingleMcpItem(body, auth, modern, protocolVersion) {
        const method = body?.method;
        const params = body?.params || {};
        const id = body?.id !== undefined ? body.id : null;
        const jsonrpc = body?.jsonrpc || '2.0';
        const headers = (0, protocol_1.mcpResponseHeaders)(modern, protocolVersion);
        const caller = { scopes: auth.scopes, subjectId: auth.subjectId };
        const wrap = (value) => modern ? (0, protocol_1.modernResult)(value) : value;
        const wrapList = (value) => modern
            ? (0, protocol_1.modernCacheableResult)(value, { ttlMs: 0, cacheScope: 'private' })
            : value;
        if (method === 'server/discover') {
            if (!modern) {
                return Response.json({ jsonrpc, id, error: { code: -32601, message: 'server/discover requires MCP 2026-07-28' } }, { status: 404, headers });
            }
            return Response.json({
                jsonrpc,
                id,
                result: (0, protocol_1.modernCacheableResult)({
                    supportedVersions: [...protocol_1.MCP_SUPPORTED_MODERN_VERSIONS],
                    capabilities: {
                        tools: { listChanged: false },
                        resources: { listChanged: false },
                        prompts: { listChanged: false }
                    },
                    _meta: {
                        'io.modelcontextprotocol/serverInfo': { name: 'DevSpace Ultra vNext', version: '2.1.0' }
                    },
                    tools: this.getToolsList(),
                    instructions: 'Secure DevSpace Ultra gateway for durable remote tasks, Kaggle compute, local agents and Chat Swarm.'
                }, { ttlMs: 0, cacheScope: 'private' })
            }, { headers });
        }
        if (method === 'initialize') {
            if (modern) {
                return Response.json({ jsonrpc, id, error: { code: -32601, message: 'initialize is not part of MCP 2026-07-28 stateless transport; use server/discover' } }, { status: 404, headers });
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
                    serverInfo: { name: 'DevSpace Ultra vNext', version: '2.1.0' },
                    tools: this.getToolsList()
                }
            }, { headers });
        }
        if (method === 'notifications/initialized' || method === 'initialized') {
            return new Response(null, { status: 204, headers });
        }
        if (method === 'ping')
            return Response.json({ jsonrpc, id, result: wrap({}) }, { headers });
        if (method === 'tools/list')
            return Response.json({ jsonrpc, id, result: wrapList({ tools: this.getToolsList() }) }, { headers });
        if (method === 'resources/list')
            return Response.json({ jsonrpc, id, result: wrapList({ resources: [] }) }, { headers });
        if (method === 'prompts/list')
            return Response.json({ jsonrpc, id, result: wrapList({ prompts: [] }) }, { headers });
        if (method === 'tools/call') {
            try {
                const toolName = params?.name;
                const args = params?.arguments || {};
                const legacy = await this.callLegacyChatSwarmTool(toolName, args, auth);
                let result;
                if (legacy.handled) {
                    result = legacy.result;
                }
                else {
                    switch (toolName) {
                        case 'remote_task_submit':
                            result = await this.mcpHandlers.handleRemoteTaskSubmit(args, caller);
                            break;
                        case 'remote_task_status':
                            result = await this.mcpHandlers.handleRemoteTaskStatus(args, caller);
                            break;
                        case 'remote_task_logs':
                            result = await this.mcpHandlers.handleRemoteTaskLogs(args, caller);
                            break;
                        case 'remote_task_artifacts':
                            result = await this.mcpHandlers.handleRemoteTaskArtifacts(args, caller);
                            break;
                        case 'remote_task_cancel':
                            result = await this.mcpHandlers.handleRemoteTaskCancel(args, caller);
                            break;
                        case 'kaggle_run':
                            result = await this.mcpHandlers.handleKaggleRun(args, caller);
                            break;
                        case 'kaggle_status':
                            result = await this.mcpHandlers.handleKaggleStatus(args, caller);
                            break;
                        case 'kaggle_logs':
                            result = await this.mcpHandlers.handleKaggleLogs(args, caller);
                            break;
                        case 'kaggle_result':
                            result = await this.mcpHandlers.handleKaggleResult(args, caller);
                            break;
                        case 'kaggle_project_list':
                            result = await this.mcpHandlers.handleKaggleProjectList(args, caller);
                            break;
                        case 'kaggle_project_get':
                            result = await this.mcpHandlers.handleKaggleProjectGet(args, caller);
                            break;
                        case 'kaggle_project_source':
                            result = await this.mcpHandlers.handleKaggleProjectSource(args, caller);
                            break;
                        case 'kaggle_project_files':
                            result = await this.mcpHandlers.handleKaggleProjectFiles(args, caller);
                            break;
                        case 'kaggle_project_output':
                            result = await this.mcpHandlers.handleKaggleProjectOutput(args, caller);
                            break;
                        case 'kaggle_project_logs':
                            result = await this.mcpHandlers.handleKaggleProjectLogs(args, caller);
                            break;
                        case 'kaggle_project_continue':
                            result = await this.mcpHandlers.handleKaggleProjectContinue(args, caller);
                            break;
                        case 'kaggle_project_restore':
                            result = await this.mcpHandlers.handleKaggleProjectRestore(args, caller);
                            break;
                        case 'kaggle_workspace_get':
                            result = await this.mcpHandlers.handleKaggleWorkspaceGet(args, caller);
                            break;
                        case 'kaggle_workspace_file':
                            result = await this.mcpHandlers.handleKaggleWorkspaceFile(args, caller);
                            break;
                        case 'kaggle_dataset_file':
                            result = await this.mcpHandlers.handleKaggleDatasetFile(args, caller);
                            break;
                        case 'kaggle_workspace_continue':
                            result = await this.mcpHandlers.handleKaggleWorkspaceContinue(args, caller);
                            break;
                        case 'local_project_list':
                            result = await this.mcpHandlers.handleLocalProjectList(args, caller);
                            break;
                        case 'local_project_status':
                            result = await this.mcpHandlers.handleLocalProjectStatus(args, caller);
                            break;
                        case 'local_read_file':
                            result = await this.mcpHandlers.handleLocalReadFile(args, caller);
                            break;
                        case 'local_write_file':
                            result = await this.mcpHandlers.handleLocalWriteFile(args, caller);
                            break;
                        case 'local_patch_file':
                            result = await this.mcpHandlers.handleLocalPatchFile(args, caller);
                            break;
                        case 'local_list_directory':
                            result = await this.mcpHandlers.handleLocalListDirectory(args, caller);
                            break;
                        case 'local_find_files':
                            result = await this.mcpHandlers.handleLocalFindFiles(args, caller);
                            break;
                        case 'local_search_text':
                            result = await this.mcpHandlers.handleLocalSearchText(args, caller);
                            break;
                        case 'local_find_repositories':
                            result = await this.mcpHandlers.handleLocalFindRepositories(args, caller);
                            break;
                        case 'local_create_directory':
                            result = await this.mcpHandlers.handleLocalCreateDirectory(args, caller);
                            break;
                        case 'local_git_status':
                            result = await this.mcpHandlers.handleLocalGitStatus(args, caller);
                            break;
                        case 'local_run_tests':
                            result = await this.mcpHandlers.handleLocalRunTests(args, caller);
                            break;
                        case 'local_build_project':
                            result = await this.mcpHandlers.handleLocalBuildProject(args, caller);
                            break;
                        case 'swarm_dispatch':
                            result = await this.mcpHandlers.handleSwarmDispatch(args, caller);
                            break;
                        case 'swarm_status':
                            result = await this.mcpHandlers.handleSwarmStatus(caller);
                            break;
                        case 'chat_swarm_runtime_status':
                            result = await this.mcpHandlers.handleChatSwarmRuntimeStatus(caller);
                            break;
                        case 'device_status':
                            result = await this.mcpHandlers.handleDeviceStatus(caller);
                            break;
                        case 'kill_switch_trigger':
                            result = await this.mcpHandlers.handleKillSwitchTrigger(args, caller);
                            break;
                        default:
                            return Response.json({ jsonrpc, id, error: { code: -32601, message: `Tool '${toolName}' not found` } }, { status: 404, headers });
                    }
                }
                return Response.json({
                    jsonrpc,
                    id,
                    result: wrap({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
                }, { headers });
            }
            catch (err) {
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
        return Response.json({ jsonrpc, id, error: { code: -32601, message: `Method '${method}' not found` } }, { status: modern ? 404 : 400, headers });
    }
}
exports.GatewayDurableObject = GatewayDurableObject;
