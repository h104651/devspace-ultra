import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";

const STATE_VERSION = 1;
const PAIR_TTL_MS = 10 * 60_000;
const BRIDGE_ONLINE_MS = 45_000;
const DEFAULT_CLAIM_LEASE_MS = 30 * 60_000;
const MAX_CLAIM_LEASE_MS = 2 * 60 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_TABS_PER_BRIDGE = 512;
const MAX_SNAPSHOT_NODES = 800;
const MAX_EVENT_ITEMS = 200;

const READ_ONLY_OPEN_WORLD = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
};
const MUTATING_OPEN_WORLD = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};

const SAFE_CDP_DOMAINS = new Set([
    "Accessibility",
    "Audits",
    "CacheStorage",
    "Console",
    "CSS",
    "Database",
    "Debugger",
    "DOM",
    "DOMDebugger",
    "DOMSnapshot",
    "Emulation",
    "Fetch",
    "IO",
    "Input",
    "Inspector",
    "Log",
    "Network",
    "Overlay",
    "Page",
    "Performance",
    "Profiler",
    "Runtime",
    "Storage",
    "Target",
    "Tracing",
    "WebAudio",
    "WebAuthn",
]);
const BLOCKED_CDP_METHODS = new Set([
    "Network.clearBrowserCache",
    "Network.clearBrowserCookies",
    "Network.getAllCookies",
    "Network.getCookies",
    "Network.setCookie",
    "Network.setCookies",
    "Network.deleteCookies",
    "Storage.getCookies",
    "Storage.setCookies",
    "Storage.clearDataForOrigin",
    "Storage.clearDataForStorageKey",
    "Page.crash",
]);

function sha256(value) {
    return createHash("sha256").update(String(value)).digest("base64url");
}
function randomToken(bytes = 24) {
    return randomBytes(bytes).toString("base64url");
}
function randomId(prefix) {
    return `${prefix}_${randomBytes(8).toString("hex")}`;
}
function pairCode() {
    return randomBytes(12).toString("hex").toUpperCase();
}
function nowIso() {
    return new Date().toISOString();
}
function isRecent(iso, ageMs) {
    const value = Date.parse(String(iso ?? ""));
    return Number.isFinite(value) && Date.now() - value <= ageMs;
}
function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function textResult(structuredContent, text) {
    return { content: [{ type: "text", text }], structuredContent };
}
function errorResult(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { ok: false, error: message },
    };
}
function newState() {
    return { version: STATE_VERSION, bridges: {}, claims: {} };
}
function sanitizeCapabilities(value = {}) {
    return {
        debugger: Boolean(value.debugger),
        accessibility: Boolean(value.accessibility),
        screenshots: Boolean(value.screenshots),
        network: Boolean(value.network),
        console: Boolean(value.console),
        downloads: Boolean(value.downloads),
        developerMode: Boolean(value.developerMode),
        accessMode: ["selected", "all"].includes(value.accessMode) ? value.accessMode : "selected",
        browserName: typeof value.browserName === "string" ? value.browserName.slice(0, 80) : undefined,
        browserVersion: typeof value.browserVersion === "string" ? value.browserVersion.slice(0, 80) : undefined,
        platform: typeof value.platform === "string" ? value.platform.slice(0, 80) : undefined,
    };
}
function sanitizeTab(tab) {
    const tabId = Number(tab?.tabId);
    if (!Number.isInteger(tabId) || tabId < 0)
        return undefined;
    const url = typeof tab?.url === "string" ? tab.url.slice(0, 16_384) : "";
    const title = typeof tab?.title === "string" ? tab.title.slice(0, 2_000) : "";
    return {
        tabId,
        windowId: Number.isInteger(Number(tab?.windowId)) ? Number(tab.windowId) : undefined,
        url,
        title,
        active: Boolean(tab?.active),
        pinned: Boolean(tab?.pinned),
        audible: Boolean(tab?.audible),
        discarded: Boolean(tab?.discarded),
        status: typeof tab?.status === "string" ? tab.status.slice(0, 40) : undefined,
        shared: tab?.shared !== false,
        managed: Boolean(tab?.managed),
        controllable: tab?.controllable !== false,
        debuggerAttached: Boolean(tab?.debuggerAttached),
        tabInstanceKey: typeof tab?.tabInstanceKey === "string" ? tab.tabInstanceKey.slice(0, 200) : undefined,
        updatedAt: nowIso(),
    };
}
function assertNavigableUrl(raw) {
    const value = String(raw ?? "").trim();
    if (!value)
        throw new Error("URL is required.");
    if (value === "about:blank")
        return value;
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`Invalid URL: ${value}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`Unsupported browser-control URL scheme: ${parsed.protocol}`);
    }
    return parsed.toString();
}
function compactObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    return value;
}

export class BrowserControlCoordinator {
    constructor({ stateDir }) {
        this.statePath = join(stateDir, "browser-control-state.json");
        this.state = newState();
        this.pendingPairs = new Map();
        this.bridgeQueues = new Map();
        this.bridgeWaiters = new Map();
        this.pendingCommands = new Map();
        this.claimRefs = new Map();
        this.persistQueue = Promise.resolve();
        this.ready = this.load();
        this.cleanupTimer = setInterval(() => {
            void this.cleanupExpiredClaims();
        }, 30_000);
        this.cleanupTimer.unref?.();
    }

    async load() {
        try {
            const parsed = JSON.parse(await readFile(this.statePath, "utf8"));
            if (parsed?.version !== STATE_VERSION || !parsed?.bridges || !parsed?.claims)
                throw new Error("unsupported browser-control state version");
            this.state = parsed;
            for (const bridge of Object.values(this.state.bridges)) {
                bridge.tabs = bridge.tabs && typeof bridge.tabs === "object" ? bridge.tabs : {};
            }
        }
        catch (error) {
            if (error?.code !== "ENOENT") {
                console.warn(`browser control state reset: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.state = newState();
        }
    }

    async save() {
        const persistedBridges = Object.fromEntries(Object.entries(this.state.bridges).map(([bridgeId, bridge]) => [bridgeId, {
            ...bridge,
            tabs: {},
        }]));
        const snapshot = JSON.stringify({ version: STATE_VERSION, bridges: persistedBridges, claims: this.state.claims }, null, 2);
        this.persistQueue = this.persistQueue.then(async () => {
            await mkdir(join(this.statePath, ".."), { recursive: true }).catch(() => {});
            await writeFile(this.statePath, snapshot, "utf8");
        });
        await this.persistQueue;
    }

    async close() {
        await this.ready;
        clearInterval(this.cleanupTimer);
        for (const waiters of this.bridgeWaiters.values()) {
            for (const waiter of [...waiters])
                waiter.resolve(undefined);
        }
        this.bridgeWaiters.clear();
        for (const pending of this.pendingCommands.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Browser control server closed."));
        }
        this.pendingCommands.clear();
        await this.persistQueue;
    }

    isBridgeOnline(bridge) {
        return Boolean(bridge?.tokenHash) && isRecent(bridge.lastSeenAt, BRIDGE_ONLINE_MS);
    }

    async beginPair({ label, ttlSeconds } = {}) {
        await this.ready;
        const code = pairCode();
        const ttlMs = clampInteger(ttlSeconds, Math.round(PAIR_TTL_MS / 1000), 60, 1800) * 1000;
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        this.pendingPairs.set(sha256(code), {
            label: typeof label === "string" ? label.trim().slice(0, 80) : undefined,
            expiresAt,
        });
        return {
            ok: true,
            pairCode: code,
            expiresAt,
            endpointHint: "http://127.0.0.1:7676",
            instruction: "Install/load the DevSpace Browser Control Bridge extension once, open its popup, set the local DevSpace endpoint if needed, then enter this one-time pair code. Do not paste browser credentials into chat.",
        };
    }

    async pairBridge({ code, instanceKey, label, capabilities, browserSessionId }) {
        await this.ready;
        const normalized = String(code ?? "").trim().toUpperCase();
        const key = sha256(normalized);
        const pending = this.pendingPairs.get(key);
        if (!pending)
            throw new Error("Invalid or expired browser-control pair code.");
        if (Date.parse(pending.expiresAt) < Date.now()) {
            this.pendingPairs.delete(key);
            throw new Error("Browser-control pair code expired.");
        }
        this.pendingPairs.delete(key);

        const normalizedInstanceKey = String(instanceKey ?? "").trim().slice(0, 200) || randomId("instance");
        let bridge = Object.values(this.state.bridges).find((item) => item.instanceKey === normalizedInstanceKey);
        if (bridge) {
            for (const [claimId, claim] of Object.entries(this.state.claims)) {
                if (claim.bridgeId !== bridge.id)
                    continue;
                delete this.state.claims[claimId];
                this.claimRefs.delete(claimId);
            }
        }
        if (!bridge) {
            const id = randomId("bridge");
            bridge = {
                id,
                instanceKey: normalizedInstanceKey,
                createdAt: nowIso(),
                tabs: {},
            };
            this.state.bridges[id] = bridge;
        }
        const bridgeToken = randomToken(32);
        bridge.tokenHash = sha256(bridgeToken);
        bridge.label = String(label ?? pending.label ?? bridge.label ?? "Chrome").trim().slice(0, 80) || "Chrome";
        bridge.capabilities = sanitizeCapabilities(capabilities);
        bridge.browserSessionId = typeof browserSessionId === "string" ? browserSessionId.slice(0, 200) : undefined;
        bridge.lastSeenAt = nowIso();
        bridge.updatedAt = bridge.lastSeenAt;
        bridge.tabs = {};
        await this.save();
        return {
            ok: true,
            bridgeId: bridge.id,
            bridgeToken,
            label: bridge.label,
            capabilities: bridge.capabilities,
        };
    }

    findBridgeByToken(token) {
        const hash = sha256(String(token ?? ""));
        const bridge = Object.values(this.state.bridges).find((item) => item.tokenHash === hash);
        if (!bridge)
            throw new Error("Invalid browser bridge token.");
        return bridge;
    }

    findClaimByToken(token) {
        const hash = sha256(String(token ?? ""));
        const claim = Object.values(this.state.claims).find((item) => item.tokenHash === hash);
        if (!claim)
            throw new Error("Invalid browser claim token.");
        if (Date.parse(claim.expiresAt) <= Date.now())
            throw new Error("Browser claim expired; claim the tab again.");
        return claim;
    }

    async syncBridge({ bridgeToken, tabs, label, capabilities, browserSessionId }) {
        await this.ready;
        const bridge = this.findBridgeByToken(bridgeToken);
        const normalizedSessionId = typeof browserSessionId === "string" ? browserSessionId.slice(0, 200) : undefined;
        const browserSessionChanged = Boolean(bridge.browserSessionId && normalizedSessionId && bridge.browserSessionId !== normalizedSessionId);
        if (normalizedSessionId)
            bridge.browserSessionId = normalizedSessionId;
        bridge.lastSeenAt = nowIso();
        bridge.updatedAt = bridge.lastSeenAt;
        if (typeof label === "string" && label.trim())
            bridge.label = label.trim().slice(0, 80);
        if (capabilities)
            bridge.capabilities = sanitizeCapabilities({ ...bridge.capabilities, ...capabilities });
        const nextTabs = {};
        for (const raw of Array.isArray(tabs) ? tabs.slice(0, MAX_TABS_PER_BRIDGE) : []) {
            const tab = sanitizeTab(raw);
            if (tab)
                nextTabs[String(tab.tabId)] = tab;
        }
        bridge.tabs = nextTabs;

        let claimsChanged = false;
        const revokedClaims = [];
        for (const [claimId, claim] of Object.entries(this.state.claims)) {
            if (claim.bridgeId !== bridge.id)
                continue;
            const liveTab = bridge.tabs[String(claim.tabId)];
            const tabInstanceChanged = Boolean(claim.tabInstanceKey && claim.tabInstanceKey !== liveTab?.tabInstanceKey);
            if (browserSessionChanged || !liveTab || tabInstanceChanged) {
                revokedClaims.push(claim);
                delete this.state.claims[claimId];
                this.claimRefs.delete(claimId);
                claimsChanged = true;
            }
        }
        await this.save();
        for (const claim of revokedClaims) {
            void this.enqueueCommand(bridge.id, "tab.detach", { tabId: claim.tabId }, 8_000).catch(() => {});
        }
        return { ok: true, bridgeId: bridge.id, tabs: Object.keys(nextTabs).length, claimsChanged, revokedClaims: revokedClaims.map((claim) => claim.id) };
    }

    bridgeSummary(bridge) {
        const tabs = Object.values(bridge.tabs ?? {});
        return {
            bridgeId: bridge.id,
            label: bridge.label,
            online: this.isBridgeOnline(bridge),
            lastSeenAt: bridge.lastSeenAt,
            capabilities: bridge.capabilities ?? {},
            tabCount: tabs.length,
        };
    }

    tabClaim(tabBridgeId, tabId) {
        const now = Date.now();
        return Object.values(this.state.claims).find((claim) => claim.bridgeId === tabBridgeId && claim.tabId === tabId && Date.parse(claim.expiresAt) > now);
    }

    publicTab(bridge, tab) {
        const claim = this.tabClaim(bridge.id, tab.tabId);
        return {
            bridgeId: bridge.id,
            bridgeLabel: bridge.label,
            tabId: tab.tabId,
            windowId: tab.windowId,
            title: tab.title,
            url: tab.url,
            active: tab.active,
            pinned: tab.pinned,
            status: tab.status,
            managed: tab.managed,
            controllable: tab.controllable,
            claimed: Boolean(claim),
            claimId: claim?.id,
            claimOwner: claim?.ownerLabel,
            claimExpiresAt: claim?.expiresAt,
        };
    }

    async status() {
        await this.ready;
        await this.cleanupExpiredClaims();
        const bridges = Object.values(this.state.bridges).map((bridge) => this.bridgeSummary(bridge));
        const tabs = [];
        for (const bridge of Object.values(this.state.bridges)) {
            for (const tab of Object.values(bridge.tabs ?? {}))
                tabs.push(this.publicTab(bridge, tab));
        }
        return {
            ok: true,
            bridges,
            tabs,
            activeClaims: Object.values(this.state.claims).map((claim) => ({
                claimId: claim.id,
                bridgeId: claim.bridgeId,
                tabId: claim.tabId,
                ownerLabel: claim.ownerLabel,
                createdAt: claim.createdAt,
                lastUsedAt: claim.lastUsedAt,
                expiresAt: claim.expiresAt,
            })),
        };
    }

    getOnlineBridge(bridgeId) {
        if (bridgeId) {
            const bridge = this.state.bridges[bridgeId];
            if (!bridge)
                throw new Error(`Unknown browser bridge ${bridgeId}.`);
            if (!this.isBridgeOnline(bridge))
                throw new Error(`Browser bridge ${bridgeId} is offline.`);
            return bridge;
        }
        const candidates = Object.values(this.state.bridges)
            .filter((bridge) => this.isBridgeOnline(bridge))
            .sort((a, b) => String(b.lastSeenAt ?? "").localeCompare(String(a.lastSeenAt ?? "")));
        if (!candidates.length)
            throw new Error("No paired Browser Control Bridge is online. Pair/load the Chrome extension first.");
        return candidates[0];
    }

    commandQueue(bridgeId) {
        let queue = this.bridgeQueues.get(bridgeId);
        if (!queue) {
            queue = [];
            this.bridgeQueues.set(bridgeId, queue);
        }
        return queue;
    }

    async nextBridgeCommand({ bridgeToken, waitMs = 20_000 }) {
        await this.ready;
        const bridge = this.findBridgeByToken(bridgeToken);
        bridge.lastSeenAt = nowIso();
        const queue = this.commandQueue(bridge.id);
        if (queue.length)
            return { ok: true, bridgeId: bridge.id, command: queue.shift() };
        const boundedWait = clampInteger(waitMs, 20_000, 0, 25_000);
        if (boundedWait === 0)
            return { ok: true, bridgeId: bridge.id, command: undefined };
        const command = await new Promise((resolve) => {
            const waiter = {
                timer: undefined,
                resolve: (value) => {
                    clearTimeout(waiter.timer);
                    const set = this.bridgeWaiters.get(bridge.id);
                    set?.delete(waiter);
                    if (set?.size === 0)
                        this.bridgeWaiters.delete(bridge.id);
                    resolve(value);
                },
            };
            waiter.timer = setTimeout(() => waiter.resolve(undefined), boundedWait);
            let set = this.bridgeWaiters.get(bridge.id);
            if (!set) {
                set = new Set();
                this.bridgeWaiters.set(bridge.id, set);
            }
            set.add(waiter);
            if (queue.length)
                waiter.resolve(queue.shift());
        });
        bridge.lastSeenAt = nowIso();
        return { ok: true, bridgeId: bridge.id, command };
    }

    dispatchQueuedCommand(bridgeId, command) {
        const waiters = this.bridgeWaiters.get(bridgeId);
        const waiter = waiters?.values().next().value;
        if (waiter) {
            waiter.resolve(command);
            return;
        }
        this.commandQueue(bridgeId).push(command);
    }

    async enqueueCommand(bridgeId, kind, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
        await this.ready;
        const bridge = this.state.bridges[bridgeId];
        if (!bridge)
            throw new Error(`Unknown browser bridge ${bridgeId}.`);
        if (!this.isBridgeOnline(bridge))
            throw new Error(`Browser bridge ${bridgeId} is offline.`);
        const commandId = randomId("cmd");
        const command = {
            commandId,
            kind,
            params,
            issuedAt: nowIso(),
        };
        const boundedTimeout = clampInteger(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 1_000, MAX_COMMAND_TIMEOUT_MS);
        const resultPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCommands.delete(commandId);
                reject(new Error(`Browser command timed out: ${kind}`));
            }, boundedTimeout);
            this.pendingCommands.set(commandId, { bridgeId, kind, resolve, reject, timer });
        });
        this.dispatchQueuedCommand(bridgeId, command);
        return await resultPromise;
    }

    async completeBridgeCommand({ bridgeToken, commandId, ok, result, error }) {
        await this.ready;
        const bridge = this.findBridgeByToken(bridgeToken);
        bridge.lastSeenAt = nowIso();
        const pending = this.pendingCommands.get(String(commandId ?? ""));
        if (!pending)
            return { ok: true, duplicate: true };
        if (pending.bridgeId !== bridge.id)
            throw new Error("Browser command belongs to a different bridge.");
        this.pendingCommands.delete(commandId);
        clearTimeout(pending.timer);
        if (ok === false) {
            pending.reject(new Error(String(error || `Browser command failed: ${pending.kind}`)));
        }
        else {
            pending.resolve(compactObject(result));
        }
        return { ok: true, duplicate: false };
    }

    async cleanupExpiredClaims() {
        await this.ready;
        const expired = [];
        const now = Date.now();
        for (const [claimId, claim] of Object.entries(this.state.claims)) {
            if (Date.parse(claim.expiresAt) > now)
                continue;
            expired.push(claim);
            delete this.state.claims[claimId];
            this.claimRefs.delete(claimId);
        }
        if (expired.length)
            await this.save();
        for (const claim of expired) {
            const bridge = this.state.bridges[claim.bridgeId];
            if (bridge && this.isBridgeOnline(bridge)) {
                void this.enqueueCommand(claim.bridgeId, "tab.detach", { tabId: claim.tabId }, 8_000).catch(() => {});
            }
        }
        return expired;
    }

    findCandidateTab({ bridgeId, tabId, urlContains, titleContains }) {
        const bridges = bridgeId ? [this.getOnlineBridge(bridgeId)] : Object.values(this.state.bridges).filter((bridge) => this.isBridgeOnline(bridge));
        const urlNeedle = String(urlContains ?? "").toLowerCase();
        const titleNeedle = String(titleContains ?? "").toLowerCase();
        const candidates = [];
        for (const bridge of bridges) {
            for (const tab of Object.values(bridge.tabs ?? {})) {
                if (!tab.shared || !tab.controllable)
                    continue;
                if (tabId !== undefined && tab.tabId !== tabId)
                    continue;
                if (urlNeedle && !String(tab.url ?? "").toLowerCase().includes(urlNeedle))
                    continue;
                if (titleNeedle && !String(tab.title ?? "").toLowerCase().includes(titleNeedle))
                    continue;
                const claim = this.tabClaim(bridge.id, tab.tabId);
                if (claim)
                    continue;
                candidates.push({ bridge, tab });
            }
        }
        candidates.sort((a, b) => Number(b.tab.active) - Number(a.tab.active) || String(b.tab.updatedAt ?? "").localeCompare(String(a.tab.updatedAt ?? "")));
        return candidates[0];
    }

    async claim({ bridgeId, tabId, urlContains, titleContains, openUrl, activate = true, ownerLabel, leaseSeconds }) {
        await this.ready;
        await this.cleanupExpiredClaims();
        let bridge;
        let tab;
        let createdManagedTab = false;
        if (openUrl) {
            bridge = this.getOnlineBridge(bridgeId);
            const url = assertNavigableUrl(openUrl);
            const created = await this.enqueueCommand(bridge.id, "tab.create", { url, active: Boolean(activate) }, 30_000);
            tab = sanitizeTab(created.tab);
            if (!tab)
                throw new Error("Browser bridge created a tab but did not return valid tab metadata.");
            bridge.tabs[String(tab.tabId)] = tab;
            createdManagedTab = true;
        }
        else {
            const candidate = this.findCandidateTab({ bridgeId, tabId, urlContains, titleContains });
            if (!candidate) {
                if (tabId !== undefined) {
                    const explicitBridge = bridgeId ? this.state.bridges[bridgeId] : undefined;
                    const explicitTab = explicitBridge?.tabs?.[String(tabId)];
                    if (explicitTab && this.tabClaim(explicitBridge.id, tabId))
                        throw new Error(`Tab ${tabId} is already claimed.`);
                }
                throw new Error("No matching unclaimed shared Chrome tab is available.");
            }
            ({ bridge, tab } = candidate);
            if (activate)
                await this.enqueueCommand(bridge.id, "tab.activate", { tabId: tab.tabId }, 10_000);
        }
        const normalizedOwnerLabel = String(ownerLabel ?? "agent").trim().slice(0, 120) || "agent";
        try {
            await this.enqueueCommand(bridge.id, "tab.attach", { tabId: tab.tabId, ownerLabel: normalizedOwnerLabel }, 15_000);
        }
        catch (error) {
            if (createdManagedTab) {
                delete bridge.tabs[String(tab.tabId)];
                void this.enqueueCommand(bridge.id, "page.navigate", { tabId: tab.tabId, action: "close" }, 8_000).catch(() => {});
            }
            throw error;
        }

        const claimToken = randomToken(32);
        const claimId = randomId("claim");
        const leaseMs = clampInteger(leaseSeconds, Math.round(DEFAULT_CLAIM_LEASE_MS / 1000), 60, Math.round(MAX_CLAIM_LEASE_MS / 1000)) * 1000;
        const timestamp = nowIso();
        this.state.claims[claimId] = {
            id: claimId,
            tokenHash: sha256(claimToken),
            bridgeId: bridge.id,
            tabId: tab.tabId,
            tabInstanceKey: tab.tabInstanceKey,
            ownerLabel: normalizedOwnerLabel,
            leaseMs,
            createdAt: timestamp,
            lastUsedAt: timestamp,
            expiresAt: new Date(Date.now() + leaseMs).toISOString(),
        };
        await this.save();
        return {
            ok: true,
            claimId,
            claimToken,
            expiresAt: this.state.claims[claimId].expiresAt,
            tab: this.publicTab(bridge, tab),
            instruction: "Keep claimToken private in this agent conversation. Use it for inspect/act/navigate calls, then release the tab when finished. The lease expires automatically if abandoned.",
        };
    }

    async touchClaim(claimToken) {
        await this.ready;
        const claim = this.findClaimByToken(claimToken);
        const bridge = this.state.bridges[claim.bridgeId];
        if (!bridge || !this.isBridgeOnline(bridge))
            throw new Error("The Chrome bridge holding this claim is offline.");
        const tab = bridge.tabs?.[String(claim.tabId)];
        if (!tab)
            throw new Error("The claimed Chrome tab is no longer available.");
        if (claim.tabInstanceKey && claim.tabInstanceKey !== tab.tabInstanceKey) {
            delete this.state.claims[claim.id];
            this.claimRefs.delete(claim.id);
            await this.save();
            throw new Error("Browser claim was revoked because the Chrome tab instance changed.");
        }
        claim.lastUsedAt = nowIso();
        claim.expiresAt = new Date(Date.now() + claim.leaseMs).toISOString();
        await this.save();
        return { claim, bridge, tab };
    }

    async release(claimToken) {
        await this.ready;
        const claim = this.findClaimByToken(claimToken);
        const bridge = this.state.bridges[claim.bridgeId];
        delete this.state.claims[claim.id];
        this.claimRefs.delete(claim.id);
        await this.save();
        let detached = false;
        if (bridge && this.isBridgeOnline(bridge)) {
            try {
                await this.enqueueCommand(bridge.id, "tab.detach", { tabId: claim.tabId }, 10_000);
                detached = true;
            }
            catch {}
        }
        return { ok: true, claimId: claim.id, bridgeId: claim.bridgeId, tabId: claim.tabId, detached };
    }

    async commandForClaim(claimToken, kind, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
        const { claim, bridge, tab } = await this.touchClaim(claimToken);
        const result = await this.enqueueCommand(bridge.id, kind, { tabId: tab.tabId, ownerLabel: claim.ownerLabel, claimId: claim.id, ...params }, timeoutMs);
        if (result.tab) {
            const updated = sanitizeTab(result.tab);
            if (updated)
                bridge.tabs[String(updated.tabId)] = updated;
        }
        return { claim, bridge, tab: bridge.tabs[String(tab.tabId)] ?? tab, result };
    }

    clearRefs(claimId) {
        this.claimRefs.delete(claimId);
    }

    async snapshot(claimToken, maxNodes = 300) {
        const bounded = clampInteger(maxNodes, 300, 20, MAX_SNAPSHOT_NODES);
        const { claim, bridge, tab, result } = await this.commandForClaim(claimToken, "inspect.snapshot", { maxNodes: bounded }, 45_000);
        const refs = new Map();
        const nodes = [];
        let refIndex = 1;
        for (const raw of Array.isArray(result.nodes) ? result.nodes.slice(0, bounded) : []) {
            const backendDOMNodeId = Number(raw?.backendDOMNodeId);
            let ref;
            if (Number.isInteger(backendDOMNodeId) && backendDOMNodeId > 0) {
                ref = `e${refIndex++}`;
                refs.set(ref, {
                    backendDOMNodeId,
                    frameId: typeof raw?.frameId === "string" ? raw.frameId : undefined,
                    role: String(raw?.role ?? ""),
                    name: String(raw?.name ?? ""),
                });
            }
            nodes.push({
                ref,
                depth: clampInteger(raw?.depth, 0, 0, 60),
                role: String(raw?.role ?? "").slice(0, 100),
                name: String(raw?.name ?? "").slice(0, 1_000),
                value: String(raw?.value ?? "").slice(0, 1_000),
                description: String(raw?.description ?? "").slice(0, 1_000),
                disabled: Boolean(raw?.disabled),
                checked: raw?.checked,
                selected: raw?.selected,
                expanded: raw?.expanded,
                focused: Boolean(raw?.focused),
                sensitive: Boolean(raw?.sensitive),
            });
        }
        const snapshotId = randomId("snapshot");
        this.claimRefs.set(claim.id, { snapshotId, refs, createdAt: nowIso() });
        const lines = nodes.map((node) => {
            const indent = "  ".repeat(Math.min(node.depth, 8));
            const prefix = node.ref ? `[${node.ref}] ` : "";
            const name = node.name ? ` \"${node.name.replace(/\s+/g, " ").trim()}\"` : "";
            const value = node.value && node.value !== node.name ? ` value=\"${node.value.replace(/\s+/g, " ").trim()}\"` : "";
            const flags = [
                node.sensitive ? "sensitive" : "",
                node.disabled ? "disabled" : "",
                node.focused ? "focused" : "",
                node.checked === true ? "checked" : node.checked === false ? "unchecked" : "",
                node.selected === true ? "selected" : "",
                node.expanded === true ? "expanded" : node.expanded === false ? "collapsed" : "",
            ].filter(Boolean);
            return `${indent}${prefix}${node.role || "node"}${name}${value}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
        });
        return {
            ok: true,
            claimId: claim.id,
            snapshotId,
            bridgeId: bridge.id,
            tabId: tab.tabId,
            title: result.title ?? tab.title,
            url: result.url ?? tab.url,
            viewport: result.viewport,
            nodeCount: nodes.length,
            snapshot: lines.join("\n"),
            nodes,
        };
    }

    async resolveRef(claimToken, ref) {
        const { claim } = await this.touchClaim(claimToken);
        const snapshot = this.claimRefs.get(claim.id);
        if (!snapshot)
            throw new Error("No current browser snapshot for this claim. Call browser_control_inspect(kind=snapshot) first.");
        const target = snapshot.refs.get(String(ref ?? ""));
        if (!target)
            throw new Error(`Unknown or stale browser element ref ${ref}. Take a fresh snapshot.`);
        return { claim, snapshotId: snapshot.snapshotId, target };
    }

    validateCdpMethod(method) {
        const name = String(method ?? "").trim();
        const [domain] = name.split(".");
        if (!domain || !SAFE_CDP_DOMAINS.has(domain))
            throw new Error(`CDP domain ${domain || "<missing>"} is not available through the Chrome extension debugger transport.`);
        if (BLOCKED_CDP_METHODS.has(name))
            throw new Error(`CDP method ${name} is blocked by DevSpace Browser Control safety policy.`);
        return name;
    }
}

const claimTokenSchema = z.string().min(16).describe("Private token returned by browser_control_claim for one exclusive Chrome-tab lease.");

export function registerBrowserControlTools(server, browserControl) {
    server.registerTool("browser_control_pair", {
        title: "Pair DevSpace Browser Control",
        description: "Create a short-lived one-time pairing code for the DevSpace Browser Control Bridge Chrome extension. Pairing is required once per Chrome profile/extension installation; the bridge keeps its own private token after pairing.",
        inputSchema: {
            label: z.string().min(1).max(80).optional(),
            ttlSeconds: z.number().int().min(60).max(1800).default(600),
        },
        annotations: MUTATING_OPEN_WORLD,
    }, async (input) => {
        try {
            const result = await browserControl.beginPair(input);
            return textResult(result, `Browser Control pair code: ${result.pairCode} (expires ${result.expiresAt}).`);
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_status", {
        title: "Browser Control Status",
        description: "List paired Chrome bridges, shared tabs, online state, and exclusive tab claims. Read-only; does not attach to or control a tab.",
        inputSchema: {},
        annotations: READ_ONLY_OPEN_WORLD,
    }, async () => {
        try {
            const result = await browserControl.status();
            return textResult(result, JSON.stringify(result, null, 2));
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_claim", {
        title: "Claim or Open Chrome Tab",
        description: "Acquire an exclusive lease on one shared Chrome tab, or open a new Chrome tab and claim it. Claims prevent multiple agents from controlling the same tab concurrently. If no tabId is supplied, filters prefer the active matching unclaimed tab. The claim auto-renews on browser-control calls and expires if abandoned.",
        inputSchema: {
            bridgeId: z.string().min(8).max(80).optional(),
            tabId: z.number().int().min(0).optional(),
            urlContains: z.string().max(500).optional(),
            titleContains: z.string().max(500).optional(),
            openUrl: z.string().max(16_384).optional(),
            activate: z.boolean().default(true),
            ownerLabel: z.string().min(1).max(120).optional(),
            leaseSeconds: z.number().int().min(60).max(7200).default(1800),
        },
        annotations: MUTATING_OPEN_WORLD,
    }, async (input, extra) => {
        try {
            const ownerLabel = input.ownerLabel || (extra?.sessionId ? `mcp:${String(extra.sessionId).slice(0, 12)}` : "agent");
            const result = await browserControl.claim({ ...input, ownerLabel });
            return textResult(result, `Claimed Chrome tab ${result.tab.tabId} (${result.tab.title || result.tab.url}).`);
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_release", {
        title: "Release Chrome Tab",
        description: "Release an exclusive Chrome-tab claim and detach the DevTools bridge from that tab. Always release a claimed tab when browser work is finished; abandoned claims also expire automatically.",
        inputSchema: { claimToken: claimTokenSchema },
        annotations: MUTATING_OPEN_WORLD,
    }, async (input) => {
        try {
            const result = await browserControl.release(input.claimToken);
            return textResult(result, `Released Chrome tab ${result.tabId}.`);
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_inspect", {
        title: "Inspect Claimed Chrome Tab",
        description: "Inspect a claimed Chrome tab. kind=snapshot returns a compact accessibility snapshot with stable element refs such as e1/e2; screenshot returns the current rendered page image; console/network/downloads return recent diagnostic events. Take a fresh snapshot after navigation or major page changes before using refs.",
        inputSchema: {
            claimToken: claimTokenSchema,
            kind: z.enum(["snapshot", "screenshot", "console", "network", "downloads"]).default("snapshot"),
            maxNodes: z.number().int().min(20).max(MAX_SNAPSHOT_NODES).default(300),
            fullPage: z.boolean().default(false),
            imageFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
            quality: z.number().int().min(20).max(100).default(85),
            limit: z.number().int().min(1).max(MAX_EVENT_ITEMS).default(50),
        },
        annotations: READ_ONLY_OPEN_WORLD,
    }, async (input) => {
        try {
            if (input.kind === "snapshot") {
                const result = await browserControl.snapshot(input.claimToken, input.maxNodes);
                return textResult(result, `${result.title || result.url}\n${result.snapshot}`);
            }
            if (input.kind === "screenshot") {
                const { claim, tab, result } = await browserControl.commandForClaim(input.claimToken, "inspect.screenshot", {
                    fullPage: input.fullPage,
                    format: input.imageFormat,
                    quality: input.quality,
                }, 45_000);
                const data = String(result.data ?? "");
                if (!data)
                    throw new Error("Browser bridge returned no screenshot data.");
                const mimeType = input.imageFormat === "jpeg" ? "image/jpeg" : input.imageFormat === "webp" ? "image/webp" : "image/png";
                return {
                    content: [
                        { type: "image", data, mimeType },
                        { type: "text", text: `Screenshot of Chrome tab ${tab.tabId}: ${result.title || tab.title || result.url || tab.url}` },
                    ],
                    structuredContent: {
                        ok: true,
                        claimId: claim.id,
                        tabId: tab.tabId,
                        title: result.title || tab.title,
                        url: result.url || tab.url,
                        mimeType,
                        width: result.width,
                        height: result.height,
                    },
                };
            }
            const { claim, tab, result } = await browserControl.commandForClaim(input.claimToken, "inspect.events", {
                kind: input.kind,
                limit: input.limit,
            }, 20_000);
            const structured = { ok: true, claimId: claim.id, tabId: tab.tabId, kind: input.kind, ...result };
            return textResult(structured, JSON.stringify(structured, null, 2));
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_act", {
        title: "Act in Claimed Chrome Tab",
        description: "Perform a browser action in the claimed Chrome tab using a semantic snapshot ref or viewport coordinates. Supports click/doubleClick/fill/type/press/hover/scroll/select/check/focus/drag. Password-field programmatic fill is refused by the bridge; let the user enter credentials directly in Chrome.",
        inputSchema: {
            claimToken: claimTokenSchema,
            action: z.enum(["click", "doubleClick", "fill", "type", "press", "hover", "scroll", "select", "check", "focus", "drag"]),
            ref: z.string().regex(/^e\d+$/).optional(),
            x: z.number().min(-100000).max(100000).optional(),
            y: z.number().min(-100000).max(100000).optional(),
            endX: z.number().min(-100000).max(100000).optional(),
            endY: z.number().min(-100000).max(100000).optional(),
            text: z.string().max(100_000).optional(),
            key: z.string().max(80).optional(),
            modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).optional(),
            deltaX: z.number().min(-100000).max(100000).optional(),
            deltaY: z.number().min(-100000).max(100000).optional(),
            values: z.array(z.string().max(5_000)).max(100).optional(),
            checked: z.boolean().optional(),
            button: z.enum(["left", "right", "middle"]).default("left"),
        },
        annotations: MUTATING_OPEN_WORLD,
    }, async (input) => {
        try {
            let target;
            if (input.ref) {
                target = (await browserControl.resolveRef(input.claimToken, input.ref)).target;
            }
            const { claim, tab, result } = await browserControl.commandForClaim(input.claimToken, "page.act", {
                action: input.action,
                target,
                x: input.x,
                y: input.y,
                endX: input.endX,
                endY: input.endY,
                text: input.text,
                key: input.key,
                modifiers: input.modifiers,
                deltaX: input.deltaX,
                deltaY: input.deltaY,
                values: input.values,
                checked: input.checked,
                button: input.button,
            }, input.action === "drag" ? 30_000 : 20_000);
            if (["click", "doubleClick", "press", "select", "check", "drag"].includes(input.action))
                browserControl.clearRefs(claim.id);
            const structured = { ok: true, claimId: claim.id, tabId: tab.tabId, action: input.action, ...result };
            return textResult(structured, result.message || `${input.action} completed in Chrome tab ${tab.tabId}.`);
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_navigate", {
        title: "Navigate Claimed Chrome Tab",
        description: "Navigate a claimed Chrome tab to a URL, go back/forward, reload, stop loading, bring it to the foreground, or close it. Navigation invalidates semantic element refs, so take a fresh snapshot afterwards.",
        inputSchema: {
            claimToken: claimTokenSchema,
            action: z.enum(["goto", "back", "forward", "reload", "stop", "activate", "close"]),
            url: z.string().max(16_384).optional(),
        },
        annotations: MUTATING_OPEN_WORLD,
    }, async (input) => {
        try {
            const url = input.action === "goto" ? assertNavigableUrl(input.url) : undefined;
            const { claim, tab, result } = await browserControl.commandForClaim(input.claimToken, "page.navigate", {
                action: input.action,
                url,
            }, 45_000);
            browserControl.clearRefs(claim.id);
            if (input.action === "close") {
                delete browserControl.state.claims[claim.id];
                await browserControl.save();
            }
            const structured = { ok: true, claimId: claim.id, tabId: tab.tabId, action: input.action, ...result };
            return textResult(structured, result.message || `${input.action} completed in Chrome tab ${tab.tabId}.`);
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_wait", {
        title: "Wait for Browser State",
        description: "Wait inside the claimed tab for a bounded browser condition: document load, URL substring, visible text, CSS selector, or a short fixed delay. This is event/task waiting, not background polling by the agent.",
        inputSchema: {
            claimToken: claimTokenSchema,
            condition: z.enum(["load", "url", "text", "selector", "delay"]).default("load"),
            value: z.string().max(10_000).optional(),
            timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
        },
        annotations: READ_ONLY_OPEN_WORLD,
    }, async (input) => {
        try {
            const { claim, tab, result } = await browserControl.commandForClaim(input.claimToken, "page.wait", {
                condition: input.condition,
                value: input.value,
                timeoutMs: input.timeoutMs,
            }, Math.min(MAX_COMMAND_TIMEOUT_MS, input.timeoutMs + 5_000));
            const structured = { ok: true, claimId: claim.id, tabId: tab.tabId, ...result };
            return textResult(structured, result.message || `Browser wait completed in tab ${tab.tabId}.`);
        }
        catch (error) { return errorResult(error); }
    });

    server.registerTool("browser_control_cdp", {
        title: "Browser Developer CDP",
        description: "Developer-mode escape hatch for advanced live browser debugging through Chrome DevTools Protocol. The Chrome extension must have Developer mode explicitly enabled. Only chrome.debugger-supported CDP domains are allowed; destructive browser-wide clearing/crash methods remain blocked. Use normal snapshot/act tools when possible.",
        inputSchema: {
            claimToken: claimTokenSchema,
            method: z.string().min(3).max(200),
            params: z.record(z.string(), z.any()).optional(),
        },
        annotations: MUTATING_OPEN_WORLD,
    }, async (input) => {
        try {
            const method = browserControl.validateCdpMethod(input.method);
            const { claim, bridge, tab } = await browserControl.touchClaim(input.claimToken);
            if (!bridge.capabilities?.developerMode)
                throw new Error("Browser bridge Developer mode is disabled. Enable it in the DevSpace Browser Control Bridge extension before using full CDP.");
            const result = await browserControl.enqueueCommand(bridge.id, "cdp.command", {
                tabId: tab.tabId,
                method,
                params: input.params ?? {},
            }, 45_000);
            const structured = { ok: true, claimId: claim.id, tabId: tab.tabId, method, result };
            return textResult(structured, JSON.stringify(structured, null, 2));
        }
        catch (error) { return errorResult(error); }
    });
}
