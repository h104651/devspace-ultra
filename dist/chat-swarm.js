import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";

const STATE_VERSION = 1;
const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 25_000;
const WAIT_FOREVER = -1;
const WORKER_HEARTBEAT_MS = 20_000;
const WORKER_CHECKPOINT_MIN_MS = 20 * 60_000;
const WORKER_CHECKPOINT_JITTER_MS = 5 * 60_000;
const WORKER_OFFER_LEASE_MS = 60_000;
const BROWSER_BIND_TTL_MS = 10 * 60_000;
export const CHAT_SWARM_WORKER_UI_URI = "ui://devspace/chat-swarm-worker.html";
const MAX_WORKERS = 32;
const MAX_BATCH_TASKS = 64;
const MAX_RESULT_CHARS = 200_000;

const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
const MUTATING = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

function sha256(value) {
    return createHash("sha256").update(String(value)).digest("base64url");
}
function randomToken(bytes = 24) {
    return randomBytes(bytes).toString("base64url");
}
function randomId(prefix) {
    return `${prefix}_${randomBytes(8).toString("hex")}`;
}
function inviteCode() {
    return randomBytes(6).toString("hex").toUpperCase();
}
function normalizeInvite(value) {
    return String(value ?? "").trim().toUpperCase();
}
function nowIso() {
    return new Date().toISOString();
}
function workerCheckpointWaitMs() {
    const override = Number(process.env.DEVSPACE_CHAT_SWARM_CHECKPOINT_MS ?? "");
    if (Number.isInteger(override) && override >= 1_000)
        return override;
    const sample = randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
    return WORKER_CHECKPOINT_MIN_MS + Math.floor(sample * WORKER_CHECKPOINT_JITTER_MS);
}
function textResult(structuredContent, text) {
    return {
        content: [{ type: "text", text }],
        structuredContent,
    };
}
function errorResult(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { ok: false, error: message },
    };
}
function waitWithAbort(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const error = new Error("Worker recovery aborted by client.");
            error.name = "AbortError";
            reject(error);
            return;
        }
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            const error = new Error("Worker recovery aborted by client.");
            error.name = "AbortError";
            reject(error);
        };
        timer = setTimeout(() => {
            signal?.removeEventListener?.("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener?.("abort", onAbort, { once: true });
    });
}
async function withWorkerHeartbeat(extra, operation, phase) {
    if (typeof extra?.sendNotification !== "function")
        return await operation();
    let stopped = false;
    let sending = false;
    let progress = 0;
    const progressToken = extra?._meta?.progressToken;
    const sendHeartbeat = async () => {
        if (stopped || sending || extra?.signal?.aborted)
            return;
        sending = true;
        try {
            if (progressToken !== undefined) {
                progress += 1;
                await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                        progressToken,
                        progress,
                        message: `Chat Swarm worker parked (${phase})`,
                    },
                });
            }
            else {
                await extra.sendNotification({
                    method: "notifications/message",
                    params: {
                        level: "debug",
                        logger: "chat-swarm",
                        data: { type: "worker-heartbeat", phase, at: nowIso(), progressTokenPresent: false },
                    },
                });
            }
        }
        catch {
            // Keepalive failure must never fail the worker operation itself.
        }
        finally {
            sending = false;
        }
    };
    // Emit once immediately, then periodically. MCP clients that opt into
    // progress can reset their request timeout clock on each notification.
    void sendHeartbeat();
    const timer = setInterval(() => {
        void sendHeartbeat();
    }, WORKER_HEARTBEAT_MS);
    try {
        return await operation();
    }
    finally {
        stopped = true;
        clearInterval(timer);
    }
}
function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function peerInfo(extra, server) {
    const meta = asObject(extra?._meta);
    const preferredKeys = [
        "openai/session",
        "openai/conversation_id",
        "openai/conversationId",
        "chatgpt/session",
    ];
    let identitySource = "none";
    let identityValue;
    for (const key of preferredKeys) {
        const candidate = meta[key];
        if (typeof candidate === "string" && candidate.trim()) {
            identitySource = key;
            identityValue = candidate.trim();
            break;
        }
    }
    if (!identityValue && typeof extra?.sessionId === "string" && extra.sessionId) {
        identitySource = "mcp-session-id";
        identityValue = extra.sessionId;
    }
    const capabilities = server.server.getClientCapabilities?.() ?? {};
    const requestClientCapabilities = asObject(meta["io.modelcontextprotocol/clientCapabilities"]);
    const requestClientExtensions = asObject(requestClientCapabilities.extensions);
    const uiCapability = asObject(capabilities?.extensions?.["io.modelcontextprotocol/ui"]);
    const requestUiCapability = asObject(requestClientExtensions["io.modelcontextprotocol/ui"]);
    return {
        identitySource,
        identityFingerprint: identityValue ? sha256(identityValue).slice(0, 16) : undefined,
        requestMetaKeys: Object.keys(meta).sort(),
        samplingSupported: Boolean(capabilities?.sampling),
        samplingToolsSupported: Boolean(capabilities?.sampling?.tools),
        tasksSupported: Boolean(capabilities?.tasks),
        taskToolCallsSupported: Boolean(capabilities?.tasks?.requests?.tools?.call),
        tasksExtensionSupported: Boolean(capabilities?.extensions?.["io.modelcontextprotocol/tasks"]),
        clientCapabilityKeys: Object.keys(capabilities ?? {}).sort(),
        extensionCapabilityKeys: Object.keys(capabilities?.extensions ?? {}).sort(),
        experimentalCapabilityKeys: Object.keys(capabilities?.experimental ?? {}).sort(),
        requestClientCapabilityKeys: Object.keys(requestClientCapabilities).sort(),
        requestClientExtensionKeys: Object.keys(requestClientExtensions).sort(),
        requestTasksExtensionSupported: Boolean(requestClientExtensions["io.modelcontextprotocol/tasks"] ?? requestClientCapabilities["io.modelcontextprotocol/tasks"]),
        uiMimeTypes: Array.isArray(uiCapability.mimeTypes) ? uiCapability.mimeTypes : [],
        requestUiMimeTypes: Array.isArray(requestUiCapability.mimeTypes) ? requestUiCapability.mimeTypes : [],
    };
}

function newState() {
    return { version: STATE_VERSION, swarms: {} };
}

export class ChatSwarmCoordinator {
    constructor({ stateDir }) {
        this.statePath = join(stateDir, "chat-swarm-state.json");
        this.state = newState();
        this.workerWaiters = new Map();
        this.changeWaiters = new Map();
        this.persistQueue = Promise.resolve();
        this.ready = this.load();
    }

    async load() {
        try {
            const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
            if (parsed?.version !== STATE_VERSION || !parsed?.swarms)
                throw new Error("unsupported state version");
            this.state = parsed;
            // A server restart loses live worker execution context. Requeue any
            // claimed task so it can be picked up again instead of remaining stuck.
            for (const swarm of Object.values(this.state.swarms)) {
                swarm.revision = Number.isInteger(swarm.revision) ? swarm.revision : 0;
                for (const worker of Object.values(swarm.workers ?? {})) {
                    worker.inFlightTaskId = undefined;
                }
                for (const task of Object.values(swarm.tasks ?? {})) {
                    task.offeredWorkerId = undefined;
                    task.offeredAt = undefined;
                    if (task.status === "claimed") {
                        task.status = "queued";
                        task.workerId = undefined;
                        task.claimedAt = undefined;
                        task.executionStartedAt = undefined;
                    }
                }
            }
        }
        catch (error) {
            if (error?.code !== "ENOENT") {
                // Fail open with a fresh coordination state. The file is local and
                // non-authoritative; corrupt state must not prevent DevSpace boot.
                console.warn(`chat swarm state reset: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.state = newState();
        }
    }

    async close() {
        await this.ready;
        for (const waiters of this.workerWaiters.values()) {
            for (const waiter of waiters)
                waiter.resolve("closed");
        }
        for (const waiters of this.changeWaiters.values()) {
            for (const waiter of waiters)
                waiter.resolve("closed");
        }
        this.workerWaiters.clear();
        this.changeWaiters.clear();
        await this.persistQueue;
    }

    async save() {
        const snapshot = JSON.stringify(this.state, null, 2);
        this.persistQueue = this.persistQueue.then(async () => {
            await mkdir(join(this.statePath, ".."), { recursive: true }).catch(() => {});
            await writeFile(this.statePath, snapshot, "utf8");
        });
        await this.persistQueue;
    }

    touch(swarm) {
        swarm.revision = (swarm.revision ?? 0) + 1;
        swarm.updatedAt = nowIso();
        const waiters = this.changeWaiters.get(swarm.id);
        if (waiters) {
            for (const waiter of [...waiters])
                waiter.resolve("changed");
        }
    }

    findSwarmByInvite(code) {
        const hash = sha256(normalizeInvite(code));
        return Object.values(this.state.swarms).find((swarm) => swarm.inviteHash === hash);
    }

    findOrchestrator(token) {
        const hash = sha256(token);
        const swarm = Object.values(this.state.swarms).find((item) => item.orchestratorTokenHash === hash);
        if (!swarm)
            throw new Error("Invalid orchestrator token.");
        return swarm;
    }

    findWorker(token) {
        const hash = sha256(token);
        for (const swarm of Object.values(this.state.swarms)) {
            for (const worker of Object.values(swarm.workers ?? {})) {
                if (worker.tokenHash === hash && worker.active)
                    return { swarm, worker };
            }
        }
        throw new Error("Invalid or inactive worker token.");
    }

    findBrowserWorker(token) {
        const hash = sha256(token);
        for (const swarm of Object.values(this.state.swarms)) {
            for (const worker of Object.values(swarm.workers ?? {})) {
                if (worker.browserWakeTokenHash === hash && worker.active)
                    return { swarm, worker };
            }
        }
        throw new Error("Invalid or inactive browser wake token.");
    }

    async enableBrowserWake(workerToken) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        const bindCode = randomToken(18);
        worker.browserBindHash = sha256(bindCode);
        worker.browserBindExpiresAt = new Date(Date.now() + BROWSER_BIND_TTL_MS).toISOString();
        worker.browserWakeTokenHash = undefined;
        worker.browserOnline = false;
        this.touch(swarm);
        await this.save();
        return {
            ok: true,
            swarmId: swarm.id,
            workerId: worker.id,
            bindCode,
            expiresAt: worker.browserBindExpiresAt,
        };
    }

    async bindBrowser(code) {
        await this.ready;
        const hash = sha256(String(code ?? "").trim());
        const now = Date.now();
        for (const swarm of Object.values(this.state.swarms)) {
            for (const worker of Object.values(swarm.workers ?? {})) {
                if (!worker.active || worker.browserBindHash !== hash)
                    continue;
                const expiresAt = Date.parse(worker.browserBindExpiresAt ?? "");
                if (!Number.isFinite(expiresAt) || expiresAt < now)
                    throw new Error("Browser bind code expired.");
                const browserWakeToken = randomToken();
                worker.browserWakeTokenHash = sha256(browserWakeToken);
                worker.browserBindHash = undefined;
                worker.browserBindExpiresAt = undefined;
                worker.browserOnline = false;
                worker.browserLastSeenAt = nowIso();
                this.touch(swarm);
                await this.save();
                return {
                    ok: true,
                    swarmId: swarm.id,
                    workerId: worker.id,
                    browserWakeToken,
                };
            }
        }
        throw new Error("Invalid browser bind code.");
    }

    async bindBrowserByInvite(inviteCodeValue) {
        await this.ready;
        const swarm = this.findSwarmByInvite(inviteCodeValue);
        if (!swarm || swarm.state !== "active")
            throw new Error("Invite code is invalid or the swarm is closed.");
        const candidates = Object.values(swarm.workers ?? {})
            .filter((worker) => worker.active && worker.browserBindHash && !worker.browserWakeTokenHash)
            .sort((a, b) => String(b.joinedAt ?? "").localeCompare(String(a.joinedAt ?? "")));
        const worker = candidates[0];
        if (!worker)
            throw new Error("No pending browser worker is waiting to bind for this invite.");
        const browserWakeToken = randomToken();
        worker.browserWakeTokenHash = sha256(browserWakeToken);
        worker.browserBindHash = undefined;
        worker.browserBindExpiresAt = undefined;
        worker.browserOnline = false;
        worker.browserLastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        return { ok: true, swarmId: swarm.id, workerId: worker.id, browserWakeToken, compatibilityBind: true };
    }

    async joinBrowserDirect({ inviteCode: inviteCodeValue, label, pageKey }) {
        await this.ready;
        const swarm = this.findSwarmByInvite(inviteCodeValue);
        if (!swarm || swarm.state !== "active")
            throw new Error("Invite code is invalid or the swarm is closed.");
        const normalizedPageKey = String(pageKey ?? "").trim();
        if (!normalizedPageKey)
            throw new Error("Browser page key is required.");
        const fingerprint = sha256(normalizedPageKey).slice(0, 16);
        let worker = Object.values(swarm.workers ?? {}).find((item) =>
            item.active && item.peer?.identitySource === "browser-extension" && item.peer?.identityFingerprint === fingerprint);
        let workerToken;
        if (!worker) {
            const joined = await this.join({
                inviteCode: inviteCodeValue,
                label,
                peer: {
                    identitySource: "browser-extension",
                    identityFingerprint: fingerprint,
                    requestMetaKeys: [],
                    samplingSupported: false,
                    samplingToolsSupported: false,
                },
            });
            workerToken = joined.workerToken;
            ({ worker } = this.findWorker(workerToken));
        }
        else {
            workerToken = randomToken();
            worker.tokenHash = sha256(workerToken);
            worker.lastSeenAt = nowIso();
        }
        const browserWakeToken = randomToken();
        worker.browserWakeTokenHash = sha256(browserWakeToken);
        worker.browserBindHash = undefined;
        worker.browserBindExpiresAt = undefined;
        worker.browserOnline = false;
        worker.browserLastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        return {
            ok: true,
            swarmId: swarm.id,
            workerId: worker.id,
            label: worker.label,
            workerToken,
            browserWakeToken,
            browserMode: true,
            directBrowserJoin: true,
        };
    }

    async setBrowserOnline(browserWakeToken, online) {
        await this.ready;
        const { swarm, worker } = this.findBrowserWorker(browserWakeToken);
        worker.browserOnline = Boolean(online);
        worker.browserLastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        return { ok: true, swarmId: swarm.id, workerId: worker.id, browserOnline: worker.browserOnline };
    }

    async setDockOnline(workerToken, online) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        worker.dockOnline = Boolean(online);
        worker.dockLastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        return { ok: true, swarmId: swarm.id, workerId: worker.id, dockOnline: worker.dockOnline };
    }

    async claimBrowserTask(browserWakeToken) {
        await this.ready;
        const { swarm, worker } = this.findBrowserWorker(browserWakeToken);
        worker.browserLastSeenAt = nowIso();
        const claimed = this.claimAvailableTask(swarm, worker);
        if (claimed) {
            await this.save();
            return claimed;
        }
        return { state: swarm.state === "active" ? "idle" : "closed", swarmId: swarm.id, workerId: worker.id };
    }

    async reserveBrowserWake(browserWakeToken) {
        await this.ready;
        const { swarm, worker } = this.findBrowserWorker(browserWakeToken);
        worker.browserLastSeenAt = nowIso();
        if (swarm.state !== "active")
            return { state: "closed", swarmId: swarm.id, workerId: worker.id };
        if (worker.inFlightTaskId) {
            const inFlight = swarm.tasks[worker.inFlightTaskId];
            if (inFlight?.status === "claimed")
                return { state: "busy", swarmId: swarm.id, workerId: worker.id, taskId: inFlight.id };
            worker.inFlightTaskId = undefined;
        }
        const queued = Object.values(swarm.tasks)
            .filter((task) => task.status === "queued")
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let task = queued.find((item) => item.targetWorkerId === worker.id);
        if (!task) {
            const now = Date.now();
            task = queued.find((item) => {
                if (item.targetWorkerId)
                    return false;
                if (!item.offeredWorkerId || item.offeredWorkerId === worker.id)
                    return true;
                const offeredAt = Date.parse(item.offeredAt ?? "");
                return !Number.isFinite(offeredAt) || now - offeredAt >= WORKER_OFFER_LEASE_MS;
            });
        }
        if (!task)
            return { state: "idle", swarmId: swarm.id, workerId: worker.id };
        if (!task.targetWorkerId && task.offeredWorkerId !== worker.id) {
            task.offeredWorkerId = worker.id;
            task.offeredAt = nowIso();
            this.touch(swarm);
            await this.save();
        }
        return {
            state: "task_available",
            swarmId: swarm.id,
            workerId: worker.id,
            taskId: task.id,
            targeted: Boolean(task.targetWorkerId),
        };
    }

    summary(swarm, role, worker) {
        const workers = Object.values(swarm.workers ?? {}).filter((item) => item.active);
        const tasks = Object.values(swarm.tasks ?? {});
        const counts = tasks.reduce((acc, task) => {
            acc[task.status] = (acc[task.status] ?? 0) + 1;
            return acc;
        }, {});
        return {
            ok: true,
            swarmId: swarm.id,
            name: swarm.name,
            state: swarm.state,
            role,
            workerId: worker?.id,
            workerSlots: swarm.workerSlots,
            activeWorkers: workers.length,
            workers: workers.map((item) => ({
                workerId: item.id,
                label: item.label,
                slot: item.slot,
                joinedAt: item.joinedAt,
                lastSeenAt: item.lastSeenAt,
                inFlightTaskId: item.inFlightTaskId,
                browserOnline: Boolean(item.browserOnline),
                browserLastSeenAt: item.browserLastSeenAt,
                dockOnline: Boolean(item.dockOnline),
                dockLastSeenAt: item.dockLastSeenAt,
                progressHeartbeat: Boolean(item.progressHeartbeat),
                progressHeartbeatLastSeenAt: item.progressHeartbeatLastSeenAt,
                checkpointCount: Number(item.checkpointCount ?? 0),
                lastCheckpointAt: item.lastCheckpointAt,
                peer: item.peer,
            })),
            taskCounts: counts,
            createdAt: swarm.createdAt,
            updatedAt: swarm.updatedAt,
            closedAt: swarm.closedAt,
        };
    }

    async create({ name, workerSlots, peer }) {
        await this.ready;
        const code = inviteCode();
        const orchestratorToken = randomToken();
        const id = randomId("swarm");
        const timestamp = nowIso();
        this.state.swarms[id] = {
            id,
            name: name?.trim() || `Chat Swarm ${id.slice(-6)}`,
            state: "active",
            workerSlots,
            inviteHash: sha256(code),
            orchestratorTokenHash: sha256(orchestratorToken),
            orchestratorPeer: peer,
            workers: {},
            tasks: {},
            taskKeys: {},
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        await this.save();
        return {
            ok: true,
            swarmId: id,
            inviteCode: code,
            orchestratorToken,
            workerSlots,
            peer,
            instruction: `Open ${workerSlots} other ChatGPT Classic conversations connected to this same DevSpace backend. In each worker conversation, call chat_swarm_join once with inviteCode ${code}, then immediately call chat_swarm_next exactly once with the returned workerToken. Stay parked while the swarm is active; do not poll or self-renew. The backend may return a low-frequency lease checkpoint roughly every 20-25 minutes; on a checkpoint, do not reply to the user and immediately call chat_swarm_next exactly once to continue the same worker loop. When a real task arrives, call chat_swarm_status exactly once with the saved workerToken before substantive work, then solve it fully and submit only through chat_swarm_submit. chat_swarm_submit stores the result and re-parks the same worker. Never emit idle/heartbeat/checkpoint/progress/completion messages to the user and never end the worker loop while the swarm is active.`,
        };
    }

    async join({ inviteCode: code, label, peer }) {
        await this.ready;
        const swarm = this.findSwarmByInvite(code);
        if (!swarm || swarm.state !== "active")
            throw new Error("Invite code is invalid or the swarm is closed.");
        const activeWorkers = Object.values(swarm.workers).filter((item) => item.active);
        if (activeWorkers.length >= swarm.workerSlots)
            throw new Error(`This swarm already has all ${swarm.workerSlots} worker slots filled.`);
        const requestedLabel = label?.trim();
        if (requestedLabel && activeWorkers.some((item) => item.label === requestedLabel))
            throw new Error(`Worker label ${requestedLabel} is already in use.`);
        const usedSlots = new Set(activeWorkers.map((item) => item.slot));
        let slot = 1;
        while (usedSlots.has(slot))
            slot += 1;
        const workerId = `worker-${String(slot).padStart(2, "0")}`;
        const workerToken = randomToken();
        const desktopWakeMarker = `[[CHAT_SWARM_DESKTOP:${randomToken(12)}]]`;
        const timestamp = nowIso();
        swarm.workers[workerId] = {
            id: workerId,
            slot,
            label: requestedLabel || workerId,
            tokenHash: sha256(workerToken),
            desktopWakeMarker,
            joinInviteCode: normalizeInvite(code),
            active: true,
            peer,
            joinedAt: timestamp,
            lastSeenAt: timestamp,
        };
        this.touch(swarm);
        await this.save();
        return {
            ok: true,
            swarmId: swarm.id,
            workerId,
            label: swarm.workers[workerId].label,
            workerToken,
            desktopWakeMarker,
            peer,
            instruction: "Keep this workerToken private inside this conversation. Immediately call chat_swarm_next exactly once and remain in the worker loop while the swarm is active. Do not poll or self-renew. If the backend returns a low-frequency lease checkpoint, do not reply to the user; immediately call chat_swarm_next exactly once to continue the same worker. When a real task arrives, first call the existing chat_swarm_status once with this workerToken to mark execution started, then solve it fully and send the complete result only through chat_swarm_submit. chat_swarm_submit stores the result and re-parks the same worker. Never send idle/heartbeat/checkpoint/progress/completion messages to the user and never end the worker loop while the swarm is active."
        };
    }

    async noteWorkerWaitCapabilities(workerToken, progressHeartbeat) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        worker.progressHeartbeat = Boolean(progressHeartbeat);
        worker.progressHeartbeatLastSeenAt = nowIso();
        worker.lastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        return { ok: true, swarmId: swarm.id, workerId: worker.id, progressHeartbeat: worker.progressHeartbeat };
    }

    async status(token) {
        await this.ready;
        try {
            const swarm = this.findOrchestrator(token);
            return this.summary(swarm, "orchestrator");
        }
        catch {
            const { swarm, worker } = this.findWorker(token);
            worker.lastSeenAt = nowIso();
            if (worker.inFlightTaskId) {
                const task = swarm.tasks[worker.inFlightTaskId];
                if (task?.status === "claimed" && task.workerId === worker.id && !task.executionStartedAt) {
                    task.executionStartedAt = worker.lastSeenAt;
                    this.touch(swarm);
                    await this.save();
                }
            }
            return this.summary(swarm, "worker", worker);
        }
    }

    async reserveWorkerWake(workerToken) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        if (swarm.state !== "active")
            return { state: "closed", swarmId: swarm.id, workerId: worker.id };
        if (worker.inFlightTaskId) {
            const inFlight = swarm.tasks[worker.inFlightTaskId];
            if (inFlight?.status === "claimed")
                return { state: "busy", swarmId: swarm.id, workerId: worker.id, taskId: inFlight.id };
            worker.inFlightTaskId = undefined;
        }
        const queued = Object.values(swarm.tasks)
            .filter((task) => task.status === "queued")
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let task = queued.find((item) => item.targetWorkerId === worker.id);
        if (!task) {
            const now = Date.now();
            task = queued.find((item) => {
                if (item.targetWorkerId)
                    return false;
                if (!item.offeredWorkerId || item.offeredWorkerId === worker.id)
                    return true;
                const offeredAt = Date.parse(item.offeredAt ?? "");
                return !Number.isFinite(offeredAt) || now - offeredAt >= WORKER_OFFER_LEASE_MS;
            });
        }
        if (!task)
            return { state: "idle", swarmId: swarm.id, workerId: worker.id };
        if (!task.targetWorkerId && task.offeredWorkerId !== worker.id) {
            task.offeredWorkerId = worker.id;
            task.offeredAt = nowIso();
            this.touch(swarm);
            await this.save();
        }
        return {
            state: "task_available",
            swarmId: swarm.id,
            workerId: worker.id,
            taskId: task.id,
            targeted: Boolean(task.targetWorkerId),
        };
    }

    async dispatch({ orchestratorToken, tasks }) {
        await this.ready;
        const swarm = this.findOrchestrator(orchestratorToken);
        if (swarm.state !== "active")
            throw new Error("Swarm is closed.");
        const activeWorkers = Object.values(swarm.workers).filter((item) => item.active);
        const activeWorkerIds = new Set(activeWorkers.map((item) => item.id));
        // Validate the whole batch before mutating state so fan-out is atomic.
        for (const item of tasks) {
            if (item.targetWorkerId && !activeWorkerIds.has(item.targetWorkerId))
                throw new Error(`Target worker ${item.targetWorkerId} is not active in this swarm.`);
            if (item.taskKey) {
                const existingId = swarm.taskKeys[item.taskKey];
                if (existingId) {
                    const existing = swarm.tasks[existingId];
                    if (existing.prompt !== item.prompt || existing.targetWorkerId !== item.targetWorkerId)
                        throw new Error(`taskKey ${item.taskKey} already exists with different task content.`);
                }
            }
        }
        const created = [];
        for (const item of tasks) {
            if (item.taskKey && swarm.taskKeys[item.taskKey]) {
                created.push(swarm.tasks[swarm.taskKeys[item.taskKey]]);
                continue;
            }
            const id = randomId("task");
            const task = {
                id,
                taskKey: item.taskKey,
                prompt: item.prompt,
                targetWorkerId: item.targetWorkerId,
                status: "queued",
                createdAt: nowIso(),
            };
            swarm.tasks[id] = task;
            if (item.taskKey)
                swarm.taskKeys[item.taskKey] = id;
            created.push(task);
        }
        this.touch(swarm);
        this.wakeEligibleWorkers(swarm, created);
        await this.save();
        return {
            ok: true,
            swarmId: swarm.id,
            tasks: created.map((task) => this.publicTask(task)),
        };
    }

    publicTask(task) {
        return {
            taskId: task.id,
            taskKey: task.taskKey,
            prompt: task.prompt,
            targetWorkerId: task.targetWorkerId,
            workerId: task.workerId,
            status: task.status,
            createdAt: task.createdAt,
            claimedAt: task.claimedAt,
            executionStartedAt: task.executionStartedAt,
            completedAt: task.completedAt,
            result: task.result,
            error: task.error,
            cancelReason: task.cancelReason,
        };
    }

    claimAvailableTask(swarm, worker) {
        if (swarm.state !== "active")
            return { state: "closed", swarmId: swarm.id, workerId: worker.id };
        if (worker.inFlightTaskId) {
            const existing = swarm.tasks[worker.inFlightTaskId];
            if (existing?.status === "claimed")
                return { state: "task", swarmId: swarm.id, workerId: worker.id, task: this.publicTask(existing), replay: true };
            worker.inFlightTaskId = undefined;
        }
        const task = Object.values(swarm.tasks)
            .filter((item) => {
                if (item.status !== "queued")
                    return false;
                if (item.targetWorkerId)
                    return item.targetWorkerId === worker.id;
                if (item.offeredWorkerId)
                    return item.offeredWorkerId === worker.id;
                return true;
            })
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!task)
            return undefined;
        task.status = "claimed";
        task.workerId = worker.id;
        task.claimedAt = nowIso();
        task.executionStartedAt = undefined;
        task.offeredWorkerId = undefined;
        task.offeredAt = undefined;
        worker.inFlightTaskId = task.id;
        worker.lastSeenAt = nowIso();
        this.touch(swarm);
        return { state: "task", swarmId: swarm.id, workerId: worker.id, task: this.publicTask(task), replay: false };
    }

    async next({ workerToken, waitMs, signal }) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        worker.lastSeenAt = nowIso();
        const immediate = this.claimAvailableTask(swarm, worker);
        if (immediate) {
            await this.save();
            return immediate;
        }
        if (waitMs === 0)
            return { state: "idle", swarmId: swarm.id, workerId: worker.id, waitedMs: 0 };
        const wakeSignal = await this.waitForWorker(swarm, worker, waitMs, signal);
        if (wakeSignal === "closed" || swarm.state !== "active")
            return { state: "closed", swarmId: swarm.id, workerId: worker.id };
        const claimed = this.claimAvailableTask(swarm, worker);
        if (claimed) {
            await this.save();
            return claimed;
        }
        if (wakeSignal === "timeout") {
            worker.checkpointCount = Number(worker.checkpointCount ?? 0) + 1;
            worker.lastCheckpointAt = nowIso();
            worker.lastSeenAt = worker.lastCheckpointAt;
            this.touch(swarm);
            await this.save();
        }
        return { state: "idle", swarmId: swarm.id, workerId: worker.id, waitedMs: waitMs, checkpoint: wakeSignal === "timeout" };
    }

    async acknowledgeTask({ workerToken, taskId }) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        const task = swarm.tasks[taskId];
        if (!task)
            throw new Error(`Unknown task ${taskId}.`);
        if (task.status !== "claimed" || task.workerId !== worker.id)
            throw new Error(`Task ${taskId} is not claimed by ${worker.id}.`);
        if (!task.executionStartedAt)
            task.executionStartedAt = nowIso();
        worker.lastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        return { ok: true, swarmId: swarm.id, workerId: worker.id, taskId, executionStartedAt: task.executionStartedAt };
    }

    waitForWorker(swarm, worker, waitMs, signal) {
        const key = `${swarm.id}:${worker.id}`;
        return new Promise((resolve, reject) => {
            let settled = false;
            const abortError = () => {
                const error = new Error("Worker wait aborted by client.");
                error.name = "AbortError";
                return error;
            };
            const cleanup = (waiter) => {
                if (waiter.timer !== undefined)
                    clearTimeout(waiter.timer);
                if (waiter.onAbort)
                    signal?.removeEventListener?.("abort", waiter.onAbort);
                const set = this.workerWaiters.get(key);
                set?.delete(waiter);
                if (set?.size === 0)
                    this.workerWaiters.delete(key);
            };
            const waiter = {
                resolve: (value) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup(waiter);
                    resolve(value);
                },
                reject: (error) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup(waiter);
                    reject(error);
                },
                timer: undefined,
                onAbort: undefined,
            };
            if (signal?.aborted) {
                waiter.reject(abortError());
                return;
            }
            if (waitMs !== WAIT_FOREVER)
                waiter.timer = setTimeout(() => waiter.resolve("timeout"), waitMs);
            if (signal?.addEventListener) {
                waiter.onAbort = () => waiter.reject(abortError());
                signal.addEventListener("abort", waiter.onAbort, { once: true });
            }
            let set = this.workerWaiters.get(key);
            if (!set) {
                set = new Set();
                this.workerWaiters.set(key, set);
            }
            set.add(waiter);
            // Close the registration race: if work appeared between the first
            // claim attempt and waiter registration, resolve immediately.
            if (swarm.state !== "active" || this.hasEligibleQueuedTask(swarm, worker))
                waiter.resolve(swarm.state === "active" ? "work" : "closed");
        });
    }

    hasEligibleQueuedTask(swarm, worker) {
        return Object.values(swarm.tasks).some((task) => task.status === "queued" && (!task.targetWorkerId || task.targetWorkerId === worker.id));
    }

    wakeWorker(swarmId, workerId, value = "work") {
        const key = `${swarmId}:${workerId}`;
        const waiters = this.workerWaiters.get(key);
        if (!waiters)
            return false;
        for (const waiter of [...waiters])
            waiter.resolve(value);
        return true;
    }

    wakeEligibleWorkers(swarm, tasks) {
        const targeted = tasks.filter((task) => task.status === "queued" && task.targetWorkerId);
        const genericCount = tasks.filter((task) => task.status === "queued" && !task.targetWorkerId).length;
        const alreadyWoken = new Set();
        for (const task of targeted) {
            if (this.wakeWorker(swarm.id, task.targetWorkerId))
                alreadyWoken.add(task.targetWorkerId);
        }
        if (!genericCount)
            return;
        const waitingWorkerIds = [];
        for (const key of this.workerWaiters.keys()) {
            const prefix = `${swarm.id}:`;
            if (!key.startsWith(prefix))
                continue;
            const workerId = key.slice(prefix.length);
            const worker = swarm.workers[workerId];
            if (!worker?.active || worker.inFlightTaskId || alreadyWoken.has(workerId))
                continue;
            waitingWorkerIds.push(workerId);
        }
        waitingWorkerIds.sort();
        for (const workerId of waitingWorkerIds.slice(0, genericCount))
            this.wakeWorker(swarm.id, workerId);
    }

    async submit({ workerToken, taskId, status, result, error, waitForNextMs, signal }) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        const task = swarm.tasks[taskId];
        if (!task)
            throw new Error(`Unknown task ${taskId}.`);
        if (task.status === "cancelled")
            throw new Error(`Task ${taskId} was cancelled and cannot accept a result.`);
        if (task.status === "completed" || task.status === "failed") {
            if (task.workerId !== worker.id)
                throw new Error(`Task ${taskId} was already completed by another worker.`);
            const duplicateResponse = { ok: true, duplicate: true, submitted: this.publicTask(task) };
            if (waitForNextMs !== 0)
                duplicateResponse.next = await this.next({ workerToken, waitMs: waitForNextMs, signal });
            return duplicateResponse;
        }
        if (task.status !== "claimed" || task.workerId !== worker.id)
            throw new Error(`Task ${taskId} is not claimed by ${worker.id}.`);
        task.status = status;
        task.result = result;
        task.error = error;
        task.completedAt = nowIso();
        worker.inFlightTaskId = undefined;
        worker.lastSeenAt = nowIso();
        this.touch(swarm);
        await this.save();
        const response = { ok: true, duplicate: false, submitted: this.publicTask(task) };
        if (waitForNextMs !== 0)
            response.next = await this.next({ workerToken, waitMs: waitForNextMs, signal });
        return response;
    }

    collectSnapshot(swarm, taskIds) {
        const ids = taskIds?.length ? taskIds : Object.keys(swarm.tasks);
        const tasks = ids.map((id) => {
            const task = swarm.tasks[id];
            if (!task)
                throw new Error(`Unknown task ${id}.`);
            return task;
        });
        return tasks;
    }

    collectSatisfied(tasks, waitFor) {
        if (waitFor === "none")
            return true;
        const terminal = (task) => ["completed", "failed", "cancelled"].includes(task.status);
        if (waitFor === "any")
            return tasks.some(terminal);
        return tasks.every(terminal);
    }

    async collect({ orchestratorToken, taskIds, waitFor, waitMs }) {
        await this.ready;
        const swarm = this.findOrchestrator(orchestratorToken);
        const deadline = Date.now() + waitMs;
        while (true) {
            const revision = swarm.revision ?? 0;
            const tasks = this.collectSnapshot(swarm, taskIds);
            if (this.collectSatisfied(tasks, waitFor) || waitMs === 0 || Date.now() >= deadline) {
                return {
                    ok: true,
                    swarmId: swarm.id,
                    waitFor,
                    complete: this.collectSatisfied(tasks, "all"),
                    tasks: tasks.map((task) => this.publicTask(task)),
                };
            }
            await this.waitForChange(swarm, revision, Math.max(1, deadline - Date.now()));
        }
    }

    waitForChange(swarm, revision, waitMs) {
        return new Promise((resolve) => {
            const waiter = {
                resolve: (value) => {
                    clearTimeout(waiter.timer);
                    const set = this.changeWaiters.get(swarm.id);
                    set?.delete(waiter);
                    if (set?.size === 0)
                        this.changeWaiters.delete(swarm.id);
                    resolve(value);
                },
                timer: undefined,
            };
            waiter.timer = setTimeout(() => waiter.resolve("timeout"), waitMs);
            let set = this.changeWaiters.get(swarm.id);
            if (!set) {
                set = new Set();
                this.changeWaiters.set(swarm.id, set);
            }
            set.add(waiter);
            // Close the snapshot/listener race.
            if ((swarm.revision ?? 0) !== revision)
                waiter.resolve("changed");
        });
    }

    async cancel({ orchestratorToken, taskIds, reason }) {
        await this.ready;
        const swarm = this.findOrchestrator(orchestratorToken);
        const changed = [];
        for (const taskId of taskIds) {
            const task = swarm.tasks[taskId];
            if (!task)
                throw new Error(`Unknown task ${taskId}.`);
            if (["completed", "failed", "cancelled"].includes(task.status))
                continue;
            task.status = "cancelled";
            task.cancelReason = reason;
            task.completedAt = nowIso();
            if (task.workerId) {
                const worker = swarm.workers[task.workerId];
                if (worker?.inFlightTaskId === task.id)
                    worker.inFlightTaskId = undefined;
            }
            changed.push(task);
        }
        if (changed.length) {
            this.touch(swarm);
            await this.save();
        }
        return { ok: true, swarmId: swarm.id, tasks: changed.map((task) => this.publicTask(task)) };
    }

    async resize({ orchestratorToken, workerSlots }) {
        await this.ready;
        const swarm = this.findOrchestrator(orchestratorToken);
        if (swarm.state !== "active")
            throw new Error("Swarm is closed.");
        if (!Number.isInteger(workerSlots) || workerSlots < 0 || workerSlots > MAX_WORKERS)
            throw new Error(`workerSlots must be between 0 and ${MAX_WORKERS}.`);

        const previousWorkerSlots = swarm.workerSlots;
        const activeWorkers = Object.values(swarm.workers ?? {}).filter((item) => item.active);
        if (workerSlots >= activeWorkers.length) {
            swarm.workerSlots = workerSlots;
            this.touch(swarm);
            await this.save();
            return {
                ok: true,
                swarmId: swarm.id,
                previousWorkerSlots,
                workerSlots,
                activeWorkers: activeWorkers.length,
                removedWorkers: [],
            };
        }

        const removalCount = activeWorkers.length - workerSlots;
        const protectedWorkerIds = new Set();
        for (const worker of activeWorkers) {
            if (worker.inFlightTaskId)
                protectedWorkerIds.add(worker.id);
        }
        for (const task of Object.values(swarm.tasks ?? {})) {
            if (!["queued", "claimed"].includes(task.status))
                continue;
            if (task.targetWorkerId)
                protectedWorkerIds.add(task.targetWorkerId);
        }

        // Shrink only contiguous tail capacity so lower worker-slot identities stay
        // stable across scale down/up. If any worker that must leave from the tail
        // is busy or targeted, refuse the resize instead of evicting a lower idle
        // worker around it. This guarantees shrink never interrupts execution and
        // preserves deterministic slot reuse when capacity is restored.
        const victims = [...activeWorkers]
            .sort((a, b) => b.slot - a.slot)
            .slice(0, removalCount);
        const blockedVictims = victims
            .filter((worker) => protectedWorkerIds.has(worker.id))
            .map((worker) => worker.id)
            .sort();
        if (blockedVictims.length) {
            throw new Error(`Cannot shrink swarm to ${workerSlots} workers while required tail workers are busy or targeted: ${blockedVictims.join(", ")}.`);
        }
        const victimIds = new Set(victims.map((worker) => worker.id));
        for (const task of Object.values(swarm.tasks ?? {})) {
            if (task.status === "queued" && task.offeredWorkerId && victimIds.has(task.offeredWorkerId)) {
                task.offeredWorkerId = undefined;
                task.offeredAt = undefined;
            }
        }
        const resizedAt = nowIso();
        for (const worker of victims) {
            worker.active = false;
            worker.inFlightTaskId = undefined;
            worker.resizedOutAt = resizedAt;
            worker.resizeReason = `swarm resized to ${workerSlots}`;
            this.wakeWorker(swarm.id, worker.id, "closed");
        }
        swarm.workerSlots = workerSlots;
        this.touch(swarm);
        this.wakeEligibleWorkers(swarm, Object.values(swarm.tasks ?? {}).filter((task) => task.status === "queued"));
        await this.save();
        return {
            ok: true,
            swarmId: swarm.id,
            previousWorkerSlots,
            workerSlots,
            activeWorkers: workerSlots,
            removedWorkers: victims.map((worker) => ({ workerId: worker.id, label: worker.label, slot: worker.slot })),
        };
    }

    getJoinInvite(orchestratorToken) {
        const swarm = this.findOrchestrator(orchestratorToken);
        const worker = Object.values(swarm.workers ?? {}).find((item) => item.joinInviteCode);
        return worker?.joinInviteCode;
    }

    async recycleWorker({ orchestratorToken, workerId, force = false, reason }) {
        await this.ready;
        const swarm = this.findOrchestrator(orchestratorToken);
        if (swarm.state !== "active")
            throw new Error("Swarm is closed.");
        const worker = swarm.workers[workerId];
        if (!worker)
            throw new Error(`Unknown worker ${workerId}.`);
        if (!worker.active) {
            return { ok: true, swarmId: swarm.id, workerId, state: "recycled", duplicate: true };
        }

        let requeuedTask;
        if (worker.inFlightTaskId) {
            const task = swarm.tasks[worker.inFlightTaskId];
            if (task?.status === "claimed" && task.workerId === worker.id) {
                if (task.executionStartedAt && !force) {
                    throw new Error(`Worker ${workerId} has task ${task.id} with execution already started; refuse recycle without force.`);
                }
                task.status = "queued";
                task.workerId = undefined;
                task.claimedAt = undefined;
                task.executionStartedAt = undefined;
                task.offeredWorkerId = undefined;
                task.offeredAt = undefined;
                requeuedTask = task;
            }
        }
        for (const task of Object.values(swarm.tasks)) {
            if (task.status === "queued" && task.offeredWorkerId === worker.id) {
                task.offeredWorkerId = undefined;
                task.offeredAt = undefined;
            }
        }
        worker.active = false;
        worker.inFlightTaskId = undefined;
        worker.recycledAt = nowIso();
        worker.recycleReason = reason;
        this.touch(swarm);
        this.wakeWorker(swarm.id, worker.id, "closed");
        this.wakeEligibleWorkers(swarm, Object.values(swarm.tasks).filter((task) => task.status === "queued"));
        await this.save();
        return {
            ok: true,
            swarmId: swarm.id,
            workerId: worker.id,
            state: "recycled",
            duplicate: false,
            forced: Boolean(force),
            requeuedTask: requeuedTask ? this.publicTask(requeuedTask) : undefined,
        };
    }

    async leave({ workerToken }) {
        await this.ready;
        const { swarm, worker } = this.findWorker(workerToken);
        if (worker.inFlightTaskId) {
            const task = swarm.tasks[worker.inFlightTaskId];
            if (task?.status === "claimed") {
                task.status = swarm.state === "active" ? "queued" : "cancelled";
                task.workerId = undefined;
                task.claimedAt = undefined;
                task.executionStartedAt = undefined;
                if (task.status === "cancelled")
                    task.completedAt = nowIso();
            }
        }
        for (const task of Object.values(swarm.tasks)) {
            if (task.status === "queued" && task.offeredWorkerId === worker.id) {
                task.offeredWorkerId = undefined;
                task.offeredAt = undefined;
            }
        }
        worker.active = false;
        worker.inFlightTaskId = undefined;
        worker.leftAt = nowIso();
        this.touch(swarm);
        this.wakeWorker(swarm.id, worker.id, "closed");
        this.wakeEligibleWorkers(swarm, Object.values(swarm.tasks).filter((task) => task.status === "queued"));
        await this.save();
        return { ok: true, swarmId: swarm.id, workerId: worker.id, state: "left" };
    }

    async closeSwarm({ orchestratorToken, cancelPending }) {
        await this.ready;
        const swarm = this.findOrchestrator(orchestratorToken);
        if (swarm.state === "closed")
            return { ok: true, swarmId: swarm.id, state: "closed", duplicate: true };
        swarm.state = "closed";
        swarm.closedAt = nowIso();
        if (cancelPending) {
            for (const task of Object.values(swarm.tasks)) {
                if (["queued", "claimed"].includes(task.status)) {
                    task.status = "cancelled";
                    task.cancelReason = "swarm closed";
                    task.completedAt = nowIso();
                }
            }
            for (const worker of Object.values(swarm.workers))
                worker.inFlightTaskId = undefined;
        }
        this.touch(swarm);
        for (const worker of Object.values(swarm.workers))
            this.wakeWorker(swarm.id, worker.id, "closed");
        await this.save();
        return { ok: true, swarmId: swarm.id, state: "closed", duplicate: false };
    }
}

function withErrors(handler) {
    return async (...args) => {
        try {
            return await handler(...args);
        }
        catch (error) {
            if (error?.name === "AbortError")
                throw error;
            return errorResult(error);
        }
    };
}

export function registerChatSwarmTools(server, coordinator, options = {}) {
    server.registerTool("chat_swarm_create", {
        title: "Create Chat Swarm",
        description: "Use this when one ChatGPT Classic conversation should become the orchestrator for several other ChatGPT Classic conversations connected to the same DevSpace backend. Creates an invite code and an orchestrator token. This does not call any external model API.",
        inputSchema: {
            name: z.string().min(1).max(80).optional(),
            workerSlots: z.number().int().min(1).max(MAX_WORKERS).default(9),
        },
        annotations: MUTATING,
    }, withErrors(async ({ name, workerSlots }, extra) => {
        const result = await coordinator.create({ name, workerSlots, peer: peerInfo(extra, server) });
        return textResult(result, `Created ${result.swarmId} with ${workerSlots} worker slots. Invite code: ${result.inviteCode}`);
    }));

    server.registerTool("chat_swarm_join", {
        title: "Join Chat Swarm",
        description: "Use this once in a worker ChatGPT Classic conversation to join the swarm and obtain a private workerToken. After this succeeds, immediately call chat_swarm_next exactly once. Do not poll or self-renew; only re-enter chat_swarm_next when the backend explicitly returns a low-frequency lease checkpoint.",
        inputSchema: {
            inviteCode: z.string().min(6).max(64),
            label: z.string().min(1).max(80).optional(),
        },
        annotations: MUTATING,
    }, withErrors(async ({ inviteCode, label }, extra) => {
        const joined = await coordinator.join({ inviteCode, label, peer: peerInfo(extra, server) });
        return textResult(joined, `Joined ${joined.swarmId} as ${joined.workerId}. Do not reply to the user. Immediately call chat_swarm_next exactly once with the returned workerToken. Stay in that worker loop; do not poll or self-renew. If the backend later returns a lease checkpoint, immediately call chat_swarm_next exactly once again without replying to the user.`);
    }));

    registerAppTool(server, "chat_swarm_dock", {
        title: "Mount Chat Swarm Worker Dock",
        description: "Use this exactly once immediately after chat_swarm_join in a ChatGPT Classic worker conversation. It is read-only and mounts the Worker Dock MCP UI for this existing worker. After it mounts, end the model turn without replying to the user. The Worker Dock will keep the idle event stream and wake this same conversation only when work is available.",
        inputSchema: {
            workerToken: z.string().min(16),
        },
        _meta: {
            ui: {
                resourceUri: CHAT_SWARM_WORKER_UI_URI,
                visibility: ["model"],
            },
            "openai/outputTemplate": CHAT_SWARM_WORKER_UI_URI,
        },
        annotations: READ_ONLY,
    }, withErrors(async ({ workerToken }) => {
        const status = await coordinator.status(workerToken);
        const result = {
            ok: true,
            swarmId: status.swarmId,
            workerId: status.workerId,
            workerToken,
            dockStreamUrl: options.workerStreamUrl,
            workerDock: true,
        };
        return textResult(result, `Worker Dock mounted for ${status.workerId}. Do not reply to the user and do not call chat_swarm_next. End this model turn now; Worker Dock will wake this same conversation when work is available.`);
    }));

    server.registerTool("chat_swarm_join_browser", {
        title: "Join Chat Swarm Browser Worker",
        description: "Use this once in a ChatGPT web worker tab when the Chat Swarm Wake Bridge browser extension is installed. It joins the swarm and returns a one-time browser bind marker. Do not start chat_swarm_next; the browser bridge will stay idle and wake this conversation only when work exists.",
        inputSchema: {
            inviteCode: z.string().min(6).max(64),
            label: z.string().min(1).max(80).optional(),
        },
        annotations: MUTATING,
    }, withErrors(async ({ inviteCode, label }, extra) => {
        const joined = await coordinator.join({ inviteCode, label, peer: peerInfo(extra, server) });
        const binding = await coordinator.enableBrowserWake(joined.workerToken);
        const marker = `[[CHAT_SWARM_BIND:${binding.bindCode}]]`;
        return textResult({ ...joined, browserBindCode: binding.bindCode, browserBindExpiresAt: binding.expiresAt, browserMode: true }, `Browser worker joined as ${joined.workerId}. Reply exactly ${marker} and end this turn. Do not call chat_swarm_next. The installed browser wake bridge will bind this tab and wake it only when work is available.`);
    }));

    server.registerTool("chat_swarm_status", {
        title: "Chat Swarm Status",
        description: "Use this when an orchestrator or worker needs the current roster and task counts. Pass the private token previously returned to this conversation by chat_swarm_create or chat_swarm_join.",
        inputSchema: { token: z.string().min(16) },
        annotations: READ_ONLY,
    }, withErrors(async ({ token }) => {
        const result = await coordinator.status(token);
        return textResult(result, `${result.swarmId}: ${result.activeWorkers}/${result.workerSlots} workers active; ${JSON.stringify(result.taskCounts)}`);
    }));

    server.registerTool("chat_swarm_resize", {
        title: "Resize Chat Swarm",
        description: "Change the live worker capacity of an active swarm. Expanding preserves all existing workers and context. Shrinking removes only idle, untargeted workers; busy workers or workers with queued targeted tasks are protected and make the shrink fail safely instead of interrupting mainline work. A size of 0 parks the swarm with no active workers.",
        inputSchema: {
            orchestratorToken: z.string().min(16),
            workerSlots: z.number().int().min(0).max(MAX_WORKERS),
        },
        annotations: MUTATING,
    }, withErrors(async (input) => {
        const result = await coordinator.resize(input);
        const removed = result.removedWorkers?.length ? ` Removed: ${result.removedWorkers.map((item) => item.label || item.workerId).join(", ")}.` : "";
        return textResult(result, `Resized ${result.swarmId} from ${result.previousWorkerSlots} to ${result.workerSlots} worker slots.${removed}`);
    }));

    server.registerTool("chat_swarm_dispatch", {
        title: "Dispatch Chat Swarm Tasks",
        description: "Use this only from the orchestrator conversation to route tasks to worker ChatGPT Classic conversations. The orchestrator decides routing dynamically: set targetWorkerId when continuity, specialization, or prior context makes a particular worker preferable; omit it for first-available routing when the task is independent or when parallelism and current workload matter more. Do not impose automatic round-robin or mandatory sticky routing. Validate the whole batch atomically and use taskKey for idempotent retries.",
        inputSchema: {
            orchestratorToken: z.string().min(16),
            tasks: z.array(z.object({
                prompt: z.string().min(1).max(100_000),
                targetWorkerId: z.string().regex(/^worker-\d{2}$/).optional(),
                taskKey: z.string().min(1).max(120).optional(),
            })).min(1).max(MAX_BATCH_TASKS),
        },
        annotations: MUTATING,
    }, withErrors(async ({ orchestratorToken, tasks }) => {
        const result = await coordinator.dispatch({ orchestratorToken, tasks });
        return textResult(result, `Dispatched ${result.tasks.length} task(s) to ${result.swarmId}.`);
    }));

    server.registerTool("chat_swarm_claim", {
        title: "Claim Browser-Woken Chat Swarm Task",
        description: "Use this only after Worker Dock or the browser wake bridge wakes a worker conversation. Claim exactly one immediately available task using the workerToken already stored in this conversation. This never waits or polls.",
        inputSchema: {
            workerToken: z.string().min(16),
        },
        annotations: READ_ONLY,
    }, withErrors(async ({ workerToken }, extra) => {
        const result = await coordinator.next({ workerToken, waitMs: 0, signal: extra?.signal });
        const text = result.state === "task"
            ? `Wake-managed worker control: solve task ${result.task.taskId}: ${result.task.prompt} Submit the complete result only through chat_swarm_submit_once. Do not report the result to the user.`
            : result.state === "closed"
                ? "Wake-managed worker control: swarm closed; stop."
                : "Wake-managed worker control: no task available. End this turn; do not poll. Worker Dock or the browser wake bridge will wake this conversation later.";
        return textResult({ ok: true, ...result }, text);
    }));

    server.registerTool("chat_swarm_ack", {
        title: "Acknowledge Chat Swarm Task Resume",
        description: "Call this exactly once immediately after chat_swarm_next returns a real task, before doing substantive work. It marks that this ChatGPT Classic worker actually resumed from the parked tool result. This lets the local Desktop Wake Bridge distinguish a healthy long-running task from a stale tool result without interrupting complex work.",
        inputSchema: {
            workerToken: z.string().min(16),
            taskId: z.string().min(8),
        },
        annotations: MUTATING,
    }, withErrors(async ({ workerToken, taskId }) => {
        const result = await coordinator.acknowledgeTask({ workerToken, taskId });
        return textResult(result, `Task ${taskId} execution acknowledged. Continue the task; do not reply to the user until the result has been submitted through chat_swarm_submit.`);
    }));

    server.registerTool("chat_swarm_next", {
        title: "Wait for Chat Swarm Work",
        description: "Use this only inside an active ChatGPT Classic worker loop. It parks for one long backend lease (normally 20-25 minutes) with low-frequency transport heartbeats. Do not poll or self-renew. If the lease checkpoint returns idle, immediately call chat_swarm_next exactly once again without replying to the user. If work arrives, solve it and submit only through chat_swarm_submit.",
        inputSchema: {
            workerToken: z.string().min(16),
        },
        annotations: READ_ONLY,
    }, withErrors(async ({ workerToken }, extra) => {
        const progressHeartbeat = extra?._meta?.progressToken !== undefined;
        await coordinator.noteWorkerWaitCapabilities(workerToken, progressHeartbeat);
        const checkpointMs = workerCheckpointWaitMs();
        const result = await withWorkerHeartbeat(
            extra,
            () => coordinator.next({ workerToken, waitMs: checkpointMs, signal: extra?.signal }),
            "checkpointed-parked-wait",
        );
        const text = result.state === "task"
            ? `Worker-loop control: do not reply to the user. First call chat_swarm_status exactly once with your saved workerToken to mark execution started. Then solve task ${result.task.taskId}: ${result.task.prompt} Send the complete answer only through chat_swarm_submit.`
            : result.state === "closed"
                ? "Worker-loop control: swarm closed; stop waiting."
                : "Worker-loop control: lease checkpoint reached. Do not reply to the user; immediately call chat_swarm_next exactly once to continue the same worker loop.";
        return textResult({ ok: true, ...result, checkpointedParkedWait: true, checkpointMs, heartbeatMs: WORKER_HEARTBEAT_MS, progressHeartbeat }, text);
    }));

    server.registerTool("chat_swarm_recover", {
        title: "Recover Chat Swarm Worker Wait",
        description: "Use this only after a transport/network error interrupted chat_swarm_next or chat_swarm_submit. It performs one fixed 30-second backoff and then re-enters the same long backend lease. Call it at most once for a given interruption; never loop recovery calls.",
        inputSchema: {
            workerToken: z.string().min(16),
        },
        annotations: READ_ONLY,
    }, withErrors(async ({ workerToken }, extra) => {
        await waitWithAbort(30_000, extra?.signal);
        const progressHeartbeat = extra?._meta?.progressToken !== undefined;
        await coordinator.noteWorkerWaitCapabilities(workerToken, progressHeartbeat);
        const checkpointMs = workerCheckpointWaitMs();
        const result = await withWorkerHeartbeat(
            extra,
            () => coordinator.next({ workerToken, waitMs: checkpointMs, signal: extra?.signal }),
            "recovery-checkpointed-wait",
        );
        const text = result.state === "task"
            ? `Worker recovery complete. Do not reply to the user. First call chat_swarm_status exactly once with your saved workerToken to mark execution started. Then continue with task ${result.task.taskId}: ${result.task.prompt} Submit only through chat_swarm_submit.`
            : result.state === "closed"
                ? "Worker recovery complete and the swarm is closed; stop waiting."
                : "Worker recovery lease checkpoint reached. Do not reply to the user; immediately call chat_swarm_next exactly once to continue the same worker loop.";
        return textResult({ ok: true, ...result, checkpointedParkedWait: true, checkpointMs, heartbeatMs: WORKER_HEARTBEAT_MS, progressHeartbeat }, text);
    }));

    server.registerTool("chat_swarm_submit_once", {
        title: "Submit Browser-Woken Chat Swarm Result",
        description: "Use this after completing one task claimed through chat_swarm_claim. Store the complete result in the backend, return immediately, do not wait for another task, and do not echo the result to the user. End the ChatGPT turn after this call; Worker Dock or the browser wake bridge remains idle and will wake the conversation again later.",
        inputSchema: {
            workerToken: z.string().min(16),
            taskId: z.string().min(8),
            status: z.enum(["completed", "failed"]).default("completed"),
            result: z.string().max(MAX_RESULT_CHARS).default(""),
            error: z.string().max(20_000).optional(),
        },
        annotations: MUTATING,
    }, withErrors(async (input, extra) => {
        const outcome = await coordinator.submit({ ...input, waitForNextMs: 0, signal: extra?.signal });
        const submitted = {
            taskId: outcome.submitted.taskId,
            taskKey: outcome.submitted.taskKey,
            workerId: outcome.submitted.workerId,
            status: outcome.submitted.status,
            completedAt: outcome.submitted.completedAt,
        };
        return textResult({ ok: outcome.ok, duplicate: outcome.duplicate, submitted, wakeManagedWorker: true }, "Worker control: result stored in backend. Do not echo the result to the user. End this turn now; Worker Dock or the browser wake bridge will remain parked and wake this conversation when another task is available.");
    }));

    server.registerTool("chat_swarm_submit", {
        title: "Submit Chat Swarm Result",
        description: "Use this inside the active ChatGPT Classic worker loop after solving a claimed task. Store the complete result in the shared backend and never echo it to the user. After storing the result, this same tool call re-parks for one long backend lease (normally 20-25 minutes). If that lease checkpoint returns idle, immediately call chat_swarm_next exactly once without replying to the user.",
        inputSchema: {
            workerToken: z.string().min(16),
            taskId: z.string().min(8),
            status: z.enum(["completed", "failed"]).default("completed"),
            result: z.string().max(MAX_RESULT_CHARS).default(""),
            error: z.string().max(20_000).optional(),
        },
        annotations: MUTATING,
    }, withErrors(async (input, extra) => {
        const progressHeartbeat = extra?._meta?.progressToken !== undefined;
        await coordinator.noteWorkerWaitCapabilities(input.workerToken, progressHeartbeat);
        const checkpointMs = workerCheckpointWaitMs();
        const result = await withWorkerHeartbeat(
            extra,
            () => coordinator.submit({ ...input, waitForNextMs: checkpointMs, signal: extra?.signal }),
            "submit-checkpointed-repark",
        );
        const submitted = {
            taskId: result.submitted.taskId,
            taskKey: result.submitted.taskKey,
            workerId: result.submitted.workerId,
            status: result.submitted.status,
            completedAt: result.submitted.completedAt,
        };
        const next = result.next;
        const directive = next?.state === "task"
            ? `Worker-loop control: result stored in backend. Do not reply to the user. First call chat_swarm_status exactly once with your saved workerToken to mark execution started. Then solve task ${next.task.taskId}: ${next.task.prompt} Then submit the complete answer with chat_swarm_submit.`
            : next?.state === "closed"
                ? "Worker-loop control: result stored in backend and the swarm is closed; stop waiting."
                : "Worker-loop control: result stored in backend; lease checkpoint reached. Do not reply to the user; immediately call chat_swarm_next exactly once to continue the same worker loop.";
        return textResult({
            ok: result.ok,
            duplicate: result.duplicate,
            submitted,
            next,
            checkpointedParkedWait: true,
            checkpointMs,
            heartbeatMs: WORKER_HEARTBEAT_MS,
            progressHeartbeat,
            workerLoop: {
                userFacingReplyAllowed: false,
                nextAction: next?.state === "task" ? "solve_and_submit" : next?.state === "closed" ? "stop" : "restore_wait",
            },
        }, directive);
    }));

    server.registerTool("chat_swarm_collect", {
        title: "Collect Chat Swarm Results",
        description: "Use this only from the orchestrator conversation to gather worker results. Default to a non-blocking snapshot (waitFor=none, waitMs=0) because long-lived collect calls can be terminated by the ChatGPT/MCP transport even though the backend and workers remain healthy. If selected tasks are still non-terminal, safely call chat_swarm_collect again later. Explicit bounded waits remain available for diagnostics, but orchestration should prefer repeated snapshots.",
        inputSchema: {
            orchestratorToken: z.string().min(16),
            taskIds: z.array(z.string().min(8)).max(MAX_BATCH_TASKS).optional(),
            waitFor: z.enum(["none", "any", "all"]).default("none"),
            waitMs: z.number().int().min(0).max(MAX_WAIT_MS).default(0),
        },
        annotations: READ_ONLY,
    }, withErrors(async (input) => {
        const result = await coordinator.collect(input);
        const terminal = result.tasks.filter((task) => ["completed", "failed", "cancelled"].includes(task.status)).length;
        return textResult(result, `${terminal}/${result.tasks.length} selected task(s) terminal in ${result.swarmId}.`);
    }));

    server.registerTool("chat_swarm_cancel", {
        title: "Cancel Chat Swarm Tasks",
        description: "Use this only from the orchestrator conversation to cancel queued or claimed swarm tasks. Cancellation is recorded in the shared backend; an already-reasoning ChatGPT worker cannot be forcibly interrupted by MCP, but its later submit will be rejected.",
        inputSchema: {
            orchestratorToken: z.string().min(16),
            taskIds: z.array(z.string().min(8)).min(1).max(MAX_BATCH_TASKS),
            reason: z.string().max(500).optional(),
        },
        annotations: MUTATING,
    }, withErrors(async (input) => {
        const result = await coordinator.cancel(input);
        return textResult(result, `Cancelled ${result.tasks.length} task(s) in ${result.swarmId}.`);
    }));

    server.registerTool("chat_swarm_recycle_worker", {
        title: "Recycle Chat Swarm Worker",
        description: "Use this only from the orchestrator conversation after an isolated ChatGPT Classic worker runtime is known to be dead, intentionally stopped, or otherwise unrecoverable. It deactivates that backend worker slot so a replacement conversation can join the same slot. If a claimed task has already acknowledged execution, recycling is refused unless force=true; use force only when you know that worker execution is gone. Any safely recyclable claimed task is requeued.",
        inputSchema: {
            orchestratorToken: z.string().min(16),
            workerId: z.string().regex(/^worker-\d{2}$/),
            force: z.boolean().default(false),
            reason: z.string().max(500).optional(),
        },
        annotations: MUTATING,
    }, withErrors(async (input) => {
        const result = await coordinator.recycleWorker(input);
        const taskText = result.requeuedTask ? ` Requeued ${result.requeuedTask.taskId}.` : "";
        return textResult(result, `${result.workerId} recycled in ${result.swarmId}; its slot is available for replacement.${taskText}`);
    }));

    server.registerTool("chat_swarm_leave", {
        title: "Leave Chat Swarm",
        description: "Use this from a worker conversation when it should leave the swarm. Any task currently claimed by that worker is safely requeued while the swarm remains active, freeing the worker slot for another ChatGPT Classic conversation.",
        inputSchema: { workerToken: z.string().min(16) },
        annotations: MUTATING,
    }, withErrors(async (input) => {
        const result = await coordinator.leave(input);
        return textResult(result, `${result.workerId} left ${result.swarmId}; its slot is available again.`);
    }));

    server.registerTool("chat_swarm_close", {
        title: "Close Chat Swarm",
        description: "Use this only from the orchestrator conversation when the multi-chat job is finished. Closes the invite and wakes parked workers so they can stop their wait loop. By default queued and claimed tasks are cancelled.",
        inputSchema: {
            orchestratorToken: z.string().min(16),
            cancelPending: z.boolean().default(true),
        },
        annotations: MUTATING,
    }, withErrors(async (input) => {
        const result = await coordinator.closeSwarm(input);
        return textResult(result, `Closed ${result.swarmId}. Parked workers have been released.`);
    }));
}

export const CHAT_SWARM_LIMITS = {
    defaultWaitMs: WAIT_FOREVER,
    waitForever: WAIT_FOREVER,
    defaultBoundedWaitMs: DEFAULT_WAIT_MS,
    maxWaitMs: MAX_WAIT_MS,
    maxWorkers: MAX_WORKERS,
    maxBatchTasks: MAX_BATCH_TASKS,
};
