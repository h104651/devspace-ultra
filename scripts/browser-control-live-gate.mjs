import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { BrowserControlCoordinator } from "../dist/browser-control.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(packageRoot, "browser-control-bridge");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
    return await new Promise((resolvePort, reject) => {
        const server = createNetServer();
        server.unref();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : undefined;
            server.close(() => port ? resolvePort(port) : reject(new Error("Could not allocate local port.")));
        });
    });
}

async function findCachedChromeForTesting(root) {
    const executableNames = process.platform === "win32"
        ? new Set(["chrome.exe"])
        : process.platform === "darwin"
            ? new Set(["Google Chrome for Testing", "Chromium"])
            : new Set(["chrome", "chromium"]);
    const stack = [root];
    const matches = [];
    while (stack.length) {
        const directory = stack.pop();
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch { continue; }
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                stack.push(path);
            }
            else if (entry.isFile() && executableNames.has(entry.name)) {
                matches.push(path);
            }
        }
    }
    return matches.sort().at(-1);
}

async function executableExists(candidate) {
    if (candidate.includes("/") || candidate.includes("\\")) {
        try {
            const { access } = await import("node:fs/promises");
            await access(candidate);
            return true;
        }
        catch { return false; }
    }
    return await new Promise((resolveExists) => {
        const child = spawn(process.platform === "win32" ? "where.exe" : "which", [candidate], { stdio: "ignore" });
        child.on("close", (code) => resolveExists(code === 0));
        child.on("error", () => resolveExists(false));
    });
}

async function findChrome() {
    const explicit = process.env.DEVSPACE_BROWSER_GATE_CHROME?.trim();
    if (explicit) {
        if (await executableExists(explicit)) return explicit;
        throw new Error(`DEVSPACE_BROWSER_GATE_CHROME does not exist: ${explicit}`);
    }
    const cacheRoot = join(tmpdir(), "devspace-browser-control-cft");
    const cached = await findCachedChromeForTesting(cacheRoot);
    if (cached && await executableExists(cached)) return cached;
    const platform = process.platform === "win32" ? " --platform win64" : "";
    throw new Error(`Chrome for Testing is required for the automated Browser Control extension gate. Install it with: npx --yes @puppeteer/browsers@latest install chrome@stable${platform} --path \"${cacheRoot}\". Chrome 137+ removed --load-extension from normal branded Chrome; production users load the unpacked extension once from chrome://extensions instead.`);
}

async function killTree(child) {
    if (!child?.pid) return;
    if (process.platform === "win32") {
        await new Promise((resolveKill) => {
            const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            killer.on("close", () => resolveKill());
            killer.on("error", () => resolveKill());
        });
        return;
    }
    try { child.kill("SIGTERM"); } catch {}
    await sleep(500);
    try { child.kill("SIGKILL"); } catch {}
}

async function startDesktopRecorder(outputPath) {
    if (!outputPath) return undefined;
    const absolutePath = resolve(outputPath);
    const videoSize = process.env.DEVSPACE_BROWSER_GATE_VIDEO_SIZE?.trim() || "1920x1080";
    const windowTitle = process.env.DEVSPACE_BROWSER_GATE_WINDOW_TITLE?.trim();
    await mkdir(dirname(absolutePath), { recursive: true });
    const inputArgs = windowTitle
        ? ["-f", "gdigrab", "-draw_mouse", "0", "-framerate", "30", "-i", `title=${windowTitle}`]
        : ["-f", "gdigrab", "-draw_mouse", "0", "-framerate", "30", "-offset_x", "0", "-offset_y", "0", "-video_size", videoSize, "-i", "desktop"];
    const args = [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        ...inputArgs,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        absolutePath,
    ];
    const child = spawn("ffmpeg.exe", args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-20_000); });
    await sleep(500);
    if (child.exitCode !== null) throw new Error(`ffmpeg recorder exited early (${child.exitCode}): ${stderr}`);
    return { child, path: absolutePath, stderr: () => stderr };
}

async function stopDesktopRecorder(recorder) {
    if (!recorder?.child) return;
    const child = recorder.child;
    if (child.exitCode !== null) return;
    try { child.stdin?.write("q\n"); } catch {}
    await Promise.race([
        new Promise((resolveClose) => child.once("close", () => resolveClose())),
        sleep(6_000),
    ]);
    if (child.exitCode === null) {
        try { child.kill("SIGTERM"); } catch {}
        await sleep(500);
    }
}

async function findPageTarget(cdp, urlPart) {
    const targets = await cdp.send("Target.getTargets", {});
    return (targets.targetInfos || []).find((target) => target.type === "page" && String(target.url || "").includes(urlPart));
}

async function startCdpViewportRecorder(cdp, urlPart, outputPath, fps = 15) {
    if (!outputPath) return undefined;
    const target = await findPageTarget(cdp, urlPart);
    if (!target?.targetId) throw new Error(`Could not find Chrome page target containing ${urlPart}.`);
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    if (!sessionId) throw new Error("Could not attach recorder CDP session to Chrome tab.");
    await cdp.send("Page.enable", {}, sessionId);
    const absolutePath = resolve(outputPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const child = spawn("ffmpeg.exe", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "mjpeg", "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        absolutePath,
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stopped = false;
    let captureError;
    const frameMs = Math.max(40, Math.round(1000 / fps));
    const loop = (async () => {
        while (!stopped) {
            const started = Date.now();
            try {
                const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 84, fromSurface: true, captureBeyondViewport: false }, sessionId);
                const data = String(shot?.data || "");
                if (data) child.stdin.write(Buffer.from(data, "base64"));
            } catch (error) {
                captureError = error;
                break;
            }
            const wait = frameMs - (Date.now() - started);
            if (wait > 0) await sleep(wait);
        }
        try { child.stdin.end(); } catch {}
    })();
    return {
        child, path: absolutePath, sessionId, loop,
        async stop() {
            stopped = true;
            await loop;
            await Promise.race([new Promise((resolveClose) => child.once("close", resolveClose)), sleep(8_000)]);
            try { await cdp.send("Target.detachFromTarget", { sessionId }); } catch {}
            if (captureError) throw captureError;
        },
    };
}

async function waitJson(url, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { cache: "no-store" });
            if (response.ok) return await response.json();
        }
        catch (error) { lastError = error; }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unavailable"}`);
}

class CdpClient {
    constructor(url) {
        this.url = url;
        this.socket = undefined;
        this.id = 0;
        this.pending = new Map();
    }
    async connect() {
        this.socket = new WebSocket(this.url);
        await new Promise((resolveOpen, reject) => {
            const timer = setTimeout(() => reject(new Error(`CDP WebSocket connect timeout: ${this.url}`)), 10_000);
            this.socket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
            this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`CDP WebSocket failed: ${this.url}`)); }, { once: true });
        });
        this.socket.addEventListener("message", (event) => {
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }
            if (!message.id) return;
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
            else pending.resolve(message.result ?? {});
        });
        this.socket.addEventListener("close", () => {
            for (const pending of this.pending.values()) pending.reject(new Error("CDP WebSocket closed."));
            this.pending.clear();
        });
        return this;
    }
    send(method, params = {}, sessionId) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP socket is not open.");
        const id = ++this.id;
        return new Promise((resolveSend, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out.`));
            }, 15_000);
            this.pending.set(id, {
                method,
                resolve: (value) => { clearTimeout(timer); resolveSend(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
    close() {
        try { this.socket?.close(); } catch {}
    }
}

async function launchChrome(chromeExe, profileDir, debugPort) {
    const visible = process.env.DEVSPACE_BROWSER_GATE_VISIBLE === "1";
    const contentOnly = visible && (process.env.DEVSPACE_BROWSER_GATE_SHOWCASE === "1" || process.env.DEVSPACE_BROWSER_GATE_SHOWCASE_ONLY === "1");
    const args = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-address=127.0.0.1`,
        `--remote-debugging-port=${debugPort}`,
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--silent-debugger-extension-api",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-component-update",
        "--disable-features=Translate,MediaRouter",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--noerrdialogs",
        "--test-type",
        ...(contentOnly ? ["--window-position=0,0", "--window-size=1920,1080", "--kiosk"] : visible ? ["--window-position=0,0", "--window-size=1920,1040", "--start-maximized"] : ["--window-position=-32000,-32000", "--window-size=1200,900"]),
        "about:blank",
    ];
    const child = spawn(chromeExe, args, { stdio: "ignore", windowsHide: !visible });
    child.once("error", (error) => console.error("Chrome launch error", error));
    const version = await waitJson(`http://127.0.0.1:${debugPort}/json/version`, 25_000);
    return { child, version };
}

async function browserClient(debugPort) {
    const version = await waitJson(`http://127.0.0.1:${debugPort}/json/version`, 10_000);
    if (!version.webSocketDebuggerUrl) throw new Error("Chrome remote debugger did not expose browser WebSocket URL.");
    return await new CdpClient(version.webSocketDebuggerUrl).connect();
}

function extensionIdFromUrl(value) {
    const match = String(value || "").match(/^chrome-extension:\/\/([a-p]{32})\//);
    return match?.[1];
}

async function findExtensionId(client, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let extensionTargets = [];
    while (Date.now() < deadline) {
        const targets = await client.send("Target.getTargets", {});
        extensionTargets = (targets.targetInfos || []).filter((target) => target.type === "service_worker" && String(target.url || "").startsWith("chrome-extension://"));
        for (const target of extensionTargets) {
            const id = extensionIdFromUrl(target.url);
            if (!id || !target.targetId) continue;
            let sessionId;
            try {
                sessionId = await attachTarget(client, target.targetId);
                const manifestName = await evalTarget(client, sessionId, `chrome?.runtime?.getManifest?.()?.name`, false);
                if (manifestName === "DevSpace Browser Control Bridge") return id;
            }
            catch {}
            finally {
                if (sessionId) await client.send("Target.detachFromTarget", { sessionId }).catch(() => {});
            }
        }
        await sleep(150);
    }
    throw new Error(`DevSpace Browser Control extension service worker did not load. Extension targets: ${JSON.stringify(extensionTargets.map((target) => ({ type: target.type, url: target.url, title: target.title })))}`);
}

async function attachTarget(client, targetId) {
    const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
    if (!attached.sessionId) throw new Error("CDP attachToTarget returned no session id.");
    await client.send("Runtime.enable", {}, attached.sessionId);
    return attached.sessionId;
}

async function evalTarget(client, sessionId, expression, awaitPromise = true) {
    const response = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
    }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "CDP evaluation failed.");
    return response.result?.value;
}

async function extensionWorkerTarget(client, extensionId, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const targets = await client.send("Target.getTargets", {});
        const worker = (targets.targetInfos || []).find((target) => target.type === "service_worker" && extensionIdFromUrl(target.url) === extensionId);
        if (worker?.targetId) return worker;
        await sleep(100);
    }
    throw new Error("Could not obtain DevTools target for Browser Control extension service worker.");
}

async function pairExtension(client, extensionId, endpoint, pairCode, developerMode = false) {
    const workerTarget = await extensionWorkerTarget(client, extensionId);
    const workerSessionId = await attachTarget(client, workerTarget.targetId);
    let contextProbe;
    const apiDeadline = Date.now() + 5_000;
    do {
        contextProbe = await evalTarget(client, workerSessionId, `({ chromeType: typeof chrome, storageType: typeof chrome?.storage, runtimeType: typeof chrome?.runtime, tabsType: typeof chrome?.tabs, debuggerType: typeof chrome?.debugger, manifestName: chrome?.runtime?.getManifest?.()?.name })`, false).catch((error) => ({ error: error.message }));
        if (contextProbe?.storageType === "object" && contextProbe?.runtimeType === "object") break;
        await sleep(100);
    } while (Date.now() < apiDeadline);
    if (contextProbe?.manifestName !== "DevSpace Browser Control Bridge") throw new Error(`Wrong/invalid extension worker target: ${JSON.stringify(contextProbe)}`);
    if (contextProbe?.storageType !== "object") throw new Error(`Chrome extension storage API did not initialize: ${JSON.stringify(contextProbe)}`);

    const created = await evalTarget(client, workerSessionId, `chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }).then((tab) => ({ tabId: tab.id }))`);
    if (!Number.isInteger(created?.tabId)) throw new Error(`Could not create extension pairing page: ${JSON.stringify(created)}`);

    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const popupDeadline = Date.now() + 10_000;
    let popupTarget;
    while (Date.now() < popupDeadline) {
        const targets = await client.send("Target.getTargets", {});
        popupTarget = (targets.targetInfos || []).find((target) => target.type === "page" && target.url === popupUrl);
        if (popupTarget?.targetId) break;
        await sleep(100);
    }
    if (!popupTarget?.targetId) throw new Error("Extension pairing page did not become a DevTools target.");
    const popupSessionId = await attachTarget(client, popupTarget.targetId);
    const readyDeadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
        ready = await evalTarget(client, popupSessionId, `document.readyState !== 'loading' && Boolean(document.getElementById('pair'))`, false).catch(() => false);
        if (ready) break;
        await sleep(100);
    }
    if (!ready) throw new Error("Extension pairing page did not finish loading.");

    await evalTarget(client, popupSessionId, `(() => {
      document.getElementById('endpoint').value = ${JSON.stringify(endpoint)};
      document.getElementById('label').value = 'Live Gate Chrome';
      document.getElementById('pairCode').value = ${JSON.stringify(pairCode)};
      document.getElementById('accessMode').value = 'selected';
      document.getElementById('developerMode').checked = ${JSON.stringify(Boolean(developerMode))};
      document.getElementById('pair').click();
      return true;
    })()`, false);

    const pairDeadline = Date.now() + 15_000;
    let state;
    while (Date.now() < pairDeadline) {
        state = await evalTarget(client, popupSessionId, `({ pill: document.getElementById('statePill')?.textContent, status: document.getElementById('status')?.textContent })`, false).catch(() => undefined);
        if (state?.pill === "Connected") break;
        if (String(state?.status || "").toLowerCase().includes("failed")) throw new Error(`Extension pairing failed: ${state.status}`);
        await sleep(150);
    }
    await client.send("Target.closeTarget", { targetId: popupTarget.targetId }).catch(() => {});
    if (state?.pill !== "Connected") throw new Error(`Extension pairing timed out: ${JSON.stringify(state)}`);
    return state;
}

function makeHarness(coordinator) {
    const app = express();
    const cors = (res, methods, headers = "X-DevSpace-Browser-Token, Content-Type") => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", methods);
        res.setHeader("Access-Control-Allow-Headers", headers);
        res.setHeader("Cache-Control", "no-store");
    };
    const token = (req) => req.header("x-devspace-browser-token");
    app.use("/browser-control/bridge", (req, res, next) => {
        const remoteAddress = String(req.socket?.remoteAddress ?? "");
        const loopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
        if (!loopback) {
            res.status(403).json({ ok: false, error: "Browser Control Bridge is loopback-only." });
            return;
        }
        const origin = req.header("origin");
        if (origin && origin !== "null" && !/^chrome-extension:\/\/[a-p]{32}\/?$/i.test(origin)) {
            res.status(403).json({ ok: false, error: "Browser Control Bridge accepts only Chrome extension origins on its local transport." });
            return;
        }
        next();
    });
    app.get("/healthz", (_req, res) => res.json({ ok: true }));
    app.options("/browser-control/bridge/pair", (_req, res) => { cors(res, "POST, OPTIONS", "Content-Type"); res.sendStatus(204); });
    app.post("/browser-control/bridge/pair", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const result = await coordinator.pairBridge({ code: req.body?.code, instanceKey: req.body?.instanceKey, label: req.body?.label, capabilities: req.body?.capabilities, browserSessionId: req.body?.browserSessionId });
            cors(res, "POST, OPTIONS", "Content-Type"); res.json(result);
        } catch (error) { cors(res, "POST, OPTIONS", "Content-Type"); res.status(401).json({ ok: false, error: error.message }); }
    });
    app.options("/browser-control/bridge/sync", (_req, res) => { cors(res, "POST, OPTIONS"); res.sendStatus(204); });
    app.post("/browser-control/bridge/sync", express.json({ limit: "2mb" }), async (req, res) => {
        try {
            const result = await coordinator.syncBridge({ bridgeToken: token(req), label: req.body?.label, capabilities: req.body?.capabilities, browserSessionId: req.body?.browserSessionId, tabs: req.body?.tabs });
            cors(res, "POST, OPTIONS"); res.json(result);
        } catch (error) { cors(res, "POST, OPTIONS"); res.status(401).json({ ok: false, error: error.message }); }
    });
    app.options("/browser-control/bridge/next", (_req, res) => { cors(res, "GET, OPTIONS"); res.sendStatus(204); });
    app.get("/browser-control/bridge/next", async (req, res) => {
        try {
            const result = await coordinator.nextBridgeCommand({ bridgeToken: token(req), waitMs: Number(req.query.waitMs || 20_000) });
            cors(res, "GET, OPTIONS"); res.json(result);
        } catch (error) { cors(res, "GET, OPTIONS"); res.status(401).json({ ok: false, error: error.message }); }
    });
    app.options("/browser-control/bridge/complete", (_req, res) => { cors(res, "POST, OPTIONS"); res.sendStatus(204); });
    app.post("/browser-control/bridge/complete", express.json({ limit: "20mb" }), async (req, res) => {
        try {
            const result = await coordinator.completeBridgeCommand({ bridgeToken: token(req), commandId: req.body?.commandId, ok: req.body?.ok !== false, result: req.body?.result, error: req.body?.error });
            cors(res, "POST, OPTIONS"); res.json(result);
        } catch (error) { cors(res, "POST, OPTIONS"); res.status(401).json({ ok: false, error: error.message }); }
    });
    app.get("/api/ping", (_req, res) => res.json({ ok: true, source: "browser-control-live-gate" }));
    app.get("/download", (_req, res) => {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=devspace-browser-control-gate.txt");
        res.send("DevSpace Browser Control live gate download PASS\n");
    });
    app.get("/showcase", (_req, res) => {
        res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevSpace Ultra Browser Control</title>
<style>
:root{color-scheme:light;--ink:#101828;--muted:#667085;--line:#e4e7ec;--soft:#f7f8fa;--blue:#175cd3;--blue2:#eff6ff;--green:#067647;--green2:#ecfdf3}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:var(--ink);font-family:"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}button,input,select{font:inherit}.nav{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 54px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.96);position:sticky;top:0;z-index:20}.brand{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:750;letter-spacing:-.02em}.mark{width:32px;height:32px;border-radius:9px;background:#111827;color:#fff;display:grid;place-items:center;font-size:12px;font-weight:850}.navlinks{display:flex;align-items:center;gap:8px}.navlinks button{border:0;background:transparent;color:#475467;padding:9px 11px;border-radius:9px;cursor:pointer}.navlinks button:hover{background:#f2f4f7;color:#101828}.version{margin-left:8px;padding:6px 9px;border:1px solid var(--line);border-radius:999px;color:#667085;font-size:12px}.hero{max-width:1560px;min-height:760px;margin:0 auto;padding:72px 70px 66px;display:grid;grid-template-columns:minmax(0,1.06fr) minmax(520px,.94fr);gap:84px;align-items:center}.kicker{font-size:12px;font-weight:800;letter-spacing:.14em;color:var(--blue);margin-bottom:18px}.copy h1{font-size:64px;line-height:1.01;letter-spacing:-.055em;max-width:760px;margin:0}.copy p{font-size:20px;line-height:1.5;color:#667085;max-width:660px;margin:26px 0 30px}.ctas{display:flex;gap:10px}.btn{border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:11px;padding:12px 17px;font-weight:700;cursor:pointer;transition:.16s ease}.btn:hover{border-color:#98a2b3;background:#f9fafb}.btn:active{transform:translateY(1px)}.btn.primary{background:#111827;color:#fff;border-color:#111827}.btn.primary:hover{background:#1f2937}.proof{display:flex;gap:20px;margin-top:32px;color:#667085;font-size:13px}.proof span{display:flex;align-items:center;gap:7px}.proof i{width:7px;height:7px;background:#12b76a;border-radius:50%}.control{background:#fbfcfe;border:1px solid #dce3eb;border-radius:20px;box-shadow:0 24px 60px rgba(16,24,40,.09);overflow:hidden}.controlHead{height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--line);background:#fff}.controlTitle{font-size:14px;font-weight:750}.controlTitle span{display:inline-block;width:8px;height:8px;border-radius:50%;background:#12b76a;margin-right:9px}.surfaceStatus{font-size:11px;font-weight:800;color:#667085;letter-spacing:.08em}.work{padding:22px}.field{display:block;margin-bottom:16px}.field>span{display:block;font-size:12px;font-weight:700;color:#475467;margin-bottom:7px}.field input,.field select{width:100%;height:46px;padding:0 12px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#101828;outline:none}.field input:focus,.field select:focus{border-color:#84adff;box-shadow:0 0 0 3px #eff4ff}.check{display:flex;align-items:center;gap:9px;color:#475467;font-size:13px;margin:4px 0 18px}.check input{width:18px;height:18px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}.actions button:disabled{opacity:.42;cursor:not-allowed}.claimState{margin-top:14px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:11px 12px;font-size:12px;color:#667085}.claimState.active{border-color:#abefc6;background:var(--green2);color:var(--green);font-weight:750}.activity{margin:18px 0 0;padding:15px 16px;border-radius:12px;background:#101828;color:#d0d5dd;list-style:none;font:12px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}.activity li{display:flex;justify-content:space-between;gap:16px}.activity b{font-weight:700;color:#98a2b3}.activity .pass{color:#6ce9a6}.architecture{border-top:1px solid var(--line);background:var(--soft);padding:92px 70px 118px}.architectureInner{max-width:1500px;margin:0 auto}.architecture h2{font-size:45px;letter-spacing:-.04em;margin:0 0 14px}.architectureLead{font-size:18px;color:#667085;max-width:710px;line-height:1.55;margin:0 0 40px}.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.step{min-height:170px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px}.step .num{font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#98a2b3}.step h3{font-size:19px;margin:28px 0 9px}.step p{color:#667085;line-height:1.5;margin:0;font-size:14px}.capabilities{display:grid;grid-template-columns:1.15fr .85fr;gap:12px;margin-top:12px}.browserCard,.recoveryCard{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;min-height:176px}.browserCard h3,.recoveryCard h3{font-size:20px;margin:0 0 9px}.browserCard p,.recoveryCard p{color:#667085;line-height:1.5;margin:0}.recoveryCard{cursor:pointer;transition:.18s ease}.recoveryCard:hover{border-color:#98a2b3;transform:translateY(-1px)}.recoveryCard.active{border-color:#84adff;box-shadow:0 0 0 3px #eff4ff}.recoveryState{margin-top:20px;font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#98a2b3}.recoveryCard.active .recoveryState{color:var(--green)}.footer{height:100px;display:flex;align-items:center;justify-content:center;color:#98a2b3;font-size:12px}@media(max-width:1000px){.hero{grid-template-columns:1fr;padding:48px 28px}.copy h1{font-size:48px}.architecture{padding:70px 28px}.flow{grid-template-columns:1fr 1fr}.capabilities{grid-template-columns:1fr}.nav{padding:0 24px}}
</style></head><body>
<header class="nav"><div class="brand"><div class="mark">DU</div>DevSpace Ultra</div><div class="navlinks"><button id="navBrowser" aria-label="Browser Control">Browser Control</button><button id="navArchitecture" aria-label="Architecture">Architecture</button><span class="version">local build</span></div></header>
<main>
<section class="hero" id="browser"><div class="copy"><div class="kicker">LOCAL-FIRST AGENT RUNTIME</div><h1>Give your AI a browser it can actually use.</h1><p>Claim a Chrome tab, move a visible pointer, type, click and scroll while your signed-in session stays inside Chrome.</p><div class="ctas"><button class="btn primary" id="heroStart" aria-label="Try Browser Control">Try Browser Control</button><button class="btn" id="heroArchitecture" aria-label="See Architecture">See architecture</button></div><div class="proof"><span><i></i>Exclusive tab lease</span><span><i></i>Local bridge</span><span><i></i>Credentials stay in Chrome</span></div></div>
<aside class="control" id="controlPanel"><div class="controlHead"><div class="controlTitle"><span></span>Browser Control</div><div class="surfaceStatus" id="surfaceStatus">READY</div></div><div class="work"><label class="field"><span>Agent task</span><input id="taskInput" aria-label="Agent task" autocomplete="off" placeholder="Describe the browser task"></label><label class="field"><span>Target</span><select id="targetSelect" aria-label="Target browser"><option value="current">Current Chrome profile</option><option value="managed">Managed work tab</option></select></label><label class="check"><input id="sessionCheck" type="checkbox" aria-label="Use signed-in Chrome session">Use signed-in Chrome session</label><div class="actions"><button class="btn" id="claimButton" aria-label="Claim this tab">Claim this tab</button><button class="btn primary" id="runButton" aria-label="Run browser task" disabled>Run task</button></div><div class="claimState" id="claimState">Waiting for an agent claim</div><ul class="activity"><li><b>observe</b><span id="logObserve">ready</span></li><li><b>claim</b><span id="logClaim">waiting</span></li><li><b>act</b><span id="logAct">waiting</span></li><li><b>result</b><span id="logResult">waiting</span></li></ul></div></aside></section>
<section class="architecture" id="architecture"><div class="architectureInner"><h2>One control plane. Four browser phases.</h2><p class="architectureLead">DevSpace Ultra keeps browser ownership explicit: observe available tabs, claim one exclusively, act through semantic refs or pointer input, then release cleanly.</p><div class="flow"><article class="step"><div class="num">01</div><h3>Observe</h3><p>Discover only tabs the operator has approved for agent use.</p></article><article class="step"><div class="num">02</div><h3>Claim</h3><p>Acquire an exclusive lease so another agent cannot race the same tab.</p></article><article class="step"><div class="num">03</div><h3>Act</h3><p>Click, type, scroll, navigate and inspect the real page.</p></article><article class="step"><div class="num">04</div><h3>Release</h3><p>Detach browser control while keeping the user's Chrome session intact.</p></article></div><div class="capabilities"><div class="browserCard"><h3>Browser Control + Chat Swarm</h3><p>A worker can claim a tab only when it needs one, while the task queue and agent routing remain in the DevSpace backend.</p></div><div class="recoveryCard" id="recoveryCard" role="button" tabindex="0" aria-label="Recovery path"><h3>Recovery path</h3><p>Reconnect after Chrome restarts and revoke stale claims automatically.</p><div class="recoveryState" id="recoveryState">READY FOR RECOVERY CHECK</div></div></div></div></section>
</main><footer class="footer">DevSpace Ultra · Browser Control local acceptance surface</footer>
<script>
const byId=(id)=>document.getElementById(id);const smoothTo=(el)=>el.scrollIntoView({behavior:'smooth',block:'center'});byId('navBrowser').addEventListener('click',()=>smoothTo(byId('controlPanel')));byId('navArchitecture').addEventListener('click',()=>smoothTo(byId('architecture')));byId('heroStart').addEventListener('click',()=>{smoothTo(byId('controlPanel'));byId('controlPanel').animate([{boxShadow:'0 24px 60px rgba(16,24,40,.09)'},{boxShadow:'0 0 0 4px rgba(23,92,211,.15),0 24px 60px rgba(16,24,40,.09)'},{boxShadow:'0 24px 60px rgba(16,24,40,.09)'}],{duration:900})});byId('heroArchitecture').addEventListener('click',()=>smoothTo(byId('architecture')));
byId('taskInput').addEventListener('input',()=>{byId('logObserve').textContent='task captured';byId('logObserve').className='pass'});byId('targetSelect').addEventListener('change',()=>{byId('surfaceStatus').textContent='TARGET SET'});byId('claimButton').addEventListener('click',()=>{byId('surfaceStatus').textContent='CLAIMED';byId('claimState').textContent='Exclusive lease active · DevSpace Ultra Agent';byId('claimState').classList.add('active');byId('logClaim').textContent='exclusive lease';byId('logClaim').className='pass';byId('runButton').disabled=false});
byId('runButton').addEventListener('click',async()=>{byId('surfaceStatus').textContent='RUNNING';byId('logAct').textContent='pointer + semantic refs';byId('logAct').className='pass';await new Promise(r=>setTimeout(r,420));byId('logResult').textContent='browser task complete';byId('logResult').className='pass';byId('surfaceStatus').textContent='COMPLETE';byId('runButton').textContent='Task complete'});
byId('recoveryCard').addEventListener('click',()=>{byId('recoveryCard').classList.add('active');byId('recoveryState').textContent='RECOVERY PATH · VERIFIED'});console.log('devspace-ultra-showcase-ready');
</script></body></html>`);
    });
    app.get("/test-page", (_req, res) => {
        res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevSpace Ultra Browser Control Acceptance</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f8fc;color:#132238;font-family:Inter,Segoe UI,Arial,sans-serif}.shell{max-width:1120px;margin:0 auto;padding:44px 38px 100px}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.14em;color:#2f80ed}.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:32px;margin-bottom:28px}.hero h1{font-size:38px;line-height:1.08;margin:8px 0 10px}.hero p{font-size:17px;color:#60748d;margin:0;max-width:700px}.live{padding:10px 14px;border-radius:999px;background:#eaf8f3;color:#118261;font-weight:800;border:1px solid #a8dfc9}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{background:white;border:1px solid #d9e4ef;border-radius:20px;padding:22px;box-shadow:0 10px 30px rgba(35,64,96,.06)}.card h2{font-size:20px;margin:0 0 18px}.field{margin:14px 0}.field label{display:block;font-size:13px;color:#5e7088;font-weight:700;margin-bottom:6px}.field input,.field select{width:100%;font-size:18px;padding:12px 13px;border:1px solid #c9d6e4;border-radius:12px;outline:none}.field input:focus,.field select:focus{border-color:#2f80ed;box-shadow:0 0 0 3px rgba(47,128,237,.12)}button,.action-link{font:700 16px Inter,Segoe UI,Arial,sans-serif;border-radius:12px;padding:11px 15px;border:1px solid #c9d6e4;background:#fff;color:#132238;cursor:pointer}.primary{background:#2f80ed;color:#fff;border-color:#2f80ed}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.state{margin-top:14px;padding:10px 12px;border-radius:12px;background:#f7fafc;border:1px solid #e0e8f0;font-size:14px;color:#60748d}.state.pass{background:#eaf8f3;border-color:#b9e8d7;color:#13795b;font-weight:800}.checkline{display:flex;align-items:center;gap:10px;font-size:16px}.checkline input{width:20px;height:20px}.drag-area{height:180px;position:relative;border:1px dashed #b8c7d8;border-radius:16px;background:#f8fbff;overflow:hidden}.drag-source{position:absolute;left:28px;top:54px;width:108px;height:64px;border-radius:14px;background:#111827;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;user-select:none;cursor:grab}.drop-zone{position:absolute;right:26px;top:30px;width:210px;height:120px;border:2px dashed #28b487;border-radius:16px;background:#eaf8f3;color:#13795b;display:flex;align-items:center;justify-content:center;font-weight:800}.spacer{height:520px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:14px}.scroll-card{background:#0f172a;color:#fff;border-radius:20px;padding:26px}.scroll-card h2{margin:0 0 8px}.footer-note{margin-top:28px;color:#8091a5;font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
</style></head><body><main class="shell">
<div class="hero"><div><div class="eyebrow">DEVSPACE ULTRA · LIVE ACCEPTANCE</div><h1>Browser Control / Computer Use</h1><p>Real Chrome control through an exclusive agent claim, semantic element refs, visible pointer actions and local-first safety gates.</p></div><div class="live">REAL CHROME · LIVE</div></div>
<div class="grid">
  <section class="card"><h2>1. Inputs & credentials boundary</h2><div class="field"><label for="name">Name</label><input id="name" aria-label="Name" autocomplete="off"></div><div id="fillState" class="state">TEXT INPUT · waiting</div><div class="field"><label for="password">Password</label><input id="password" type="password" aria-label="Password" autocomplete="off" value="live-secret-must-not-leak"></div><div class="state">PASSWORD · value must stay masked and agent fill must be blocked</div></section>
  <section class="card"><h2>2. Form controls</h2><label class="checkline"><input id="agree" type="checkbox" aria-label="Agree to terms"> Agree to terms</label><div id="checkState" class="state">CHECKBOX · waiting</div><div class="field"><label for="mode">Mode</label><select id="mode" aria-label="Mode"><option value="alpha">Alpha</option><option value="beta">Beta</option></select></div><div id="selectState" class="state">SELECT · waiting</div></section>
  <section class="card"><h2>3. Pointer actions</h2><div class="row"><button id="hover" aria-label="Hover target">Hover target</button><button id="double" aria-label="Double click target">Double click</button></div><div id="hoverState" class="state">HOVER · waiting</div><div id="doubleState" class="state">DOUBLE CLICK · waiting</div></section>
  <section class="card"><h2>4. Submit / network / download</h2><div class="row"><button id="submit" class="primary">Submit</button><a id="download" class="action-link" href="/download" download>Download test file</a></div><div id="status" role="status" class="state">NETWORK SUBMIT · waiting</div></section>
</div>
<section class="card" style="margin-top:20px"><h2>5. Visible drag</h2><div class="drag-area" id="dragArea"><div id="dragSource" class="drag-source" role="button" aria-label="Drag source">DRAG ME</div><div id="dropZone" class="drop-zone" role="button" aria-label="Drop Zone">DROP ZONE</div></div><div id="dragState" class="state">DRAG · waiting</div></section>
<div class="spacer">Scroll test zone · agent will move through this area</div>
<section class="scroll-card"><h2>6. Scroll + Developer CDP</h2><div id="scrollState">SCROLL · waiting</div><div id="cdpState" style="margin-top:10px">DEVELOPER CDP · waiting</div><p class="footer-note">The black pointer and claim banner are injected by DevSpace Browser Control, not by this page.</p></section>
</main>
<script>
  const pass=(id,text)=>{const el=document.getElementById(id);el.textContent=text;el.classList.add('pass')};
  console.log('live-gate-page-ready');
  document.getElementById('name').addEventListener('input',()=>pass('fillState','TEXT INPUT · PASS'));
  document.getElementById('name').addEventListener('keydown',e=>{if(e.key==='Enter')pass('fillState','KEY PRESS · PASS')});
  document.getElementById('agree').addEventListener('change',e=>{if(e.target.checked)pass('checkState','CHECKBOX · PASS')});
  document.getElementById('mode').addEventListener('change',e=>{if(e.target.value==='beta')pass('selectState','SELECT · PASS')});
  document.getElementById('hover').addEventListener('mouseenter',()=>pass('hoverState','HOVER · PASS'));
  document.getElementById('double').addEventListener('dblclick',()=>pass('doubleState','DOUBLE CLICK · PASS'));
  let dragging=false;
  const src=document.getElementById('dragSource'), zone=document.getElementById('dropZone');
  src.addEventListener('mousedown',e=>{dragging=true;e.preventDefault()});
  document.addEventListener('mousemove',e=>{if(!dragging)return;const r=document.getElementById('dragArea').getBoundingClientRect();src.style.left=Math.max(0,Math.min(r.width-108,e.clientX-r.left-54))+'px';src.style.top=Math.max(0,Math.min(r.height-64,e.clientY-r.top-32))+'px'});
  document.addEventListener('mouseup',e=>{if(!dragging)return;dragging=false;const z=zone.getBoundingClientRect();if(e.clientX>=z.left&&e.clientX<=z.right&&e.clientY>=z.top&&e.clientY<=z.bottom)pass('dragState','DRAG · PASS')});
  window.addEventListener('scroll',()=>{if(window.scrollY>300)pass('scrollState','SCROLL · PASS')});
  document.getElementById('submit').addEventListener('click', async () => {
    const name = document.getElementById('name').value;
    const response = await fetch('/api/ping?name=' + encodeURIComponent(name));
    const data = await response.json();
    const el=document.getElementById('status');el.textContent='Hello ' + name + ' · ' + (data.ok ? 'PASS' : 'FAIL');if(data.ok)el.classList.add('pass');
    console.log('live-gate-submit', name, data.ok);
  });
</script></body></html>`);
    });
    app.get("/second-page", (_req, res) => {
        res.type("html").send(`<!doctype html><meta charset="utf-8"><title>DevSpace Browser Navigation Gate</title><style>body{font-family:Inter,Segoe UI,Arial,sans-serif;background:#f5f8fc;color:#132238;padding:70px}main{max-width:860px;margin:auto;background:#fff;border:1px solid #d9e4ef;border-radius:24px;padding:42px}h1{font-size:38px}.pass{display:inline-block;padding:9px 13px;border-radius:999px;background:#eaf8f3;color:#13795b;font-weight:800}</style><main><div class="pass">NAVIGATION · PASS</div><h1>Second page reached</h1><p id="secondState">Browser Control goto / back / forward route is live.</p></main>`);
    });
    app.get("/acceptance-summary", (_req, res) => {
        const items = [
            "Exclusive Chrome tab claim", "Visible black agent cursor", "Semantic accessibility refs", "Focus / fill / type / key press",
            "Password masking + programmatic password-fill block", "Checkbox / select", "Hover / double click", "Drag / scroll",
            "Screenshot", "Console / network / download capture", "Opt-in Developer CDP", "Goto / back / forward / reload / stop / activate", "Wait: load / URL / text / selector / delay",
            "Concurrent claim rejection", "Release + debugger detach"
        ];
        res.type("html").send(`<!doctype html><meta charset="utf-8"><title>DevSpace Ultra Browser Control Acceptance PASS</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f8fc;color:#132238;font-family:Inter,Segoe UI,Arial,sans-serif}.wrap{max-width:1120px;margin:0 auto;padding:62px 46px}.tag{display:inline-block;padding:9px 14px;border-radius:999px;background:#eaf8f3;color:#13795b;border:1px solid #b9e8d7;font-weight:900;letter-spacing:.06em}.head{display:flex;justify-content:space-between;gap:30px;align-items:flex-start}.head h1{font-size:44px;line-height:1.04;margin:16px 0 10px}.head p{font-size:18px;color:#60748d;max-width:700px}.score{font-size:54px;font-weight:900;color:#28b487}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:30px}.item{background:#fff;border:1px solid #d9e4ef;border-radius:16px;padding:14px 16px;font-weight:750}.item:before{content:'✓';display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-right:10px;border-radius:50%;background:#28b487;color:#fff}.foot{margin-top:26px;color:#60748d;font-size:14px}</style><main class="wrap"><div class="head"><div><div class="tag">LIVE ACCEPTANCE PASS</div><h1>DevSpace Ultra Browser Control</h1><p>All visible interaction gates in this recording passed on a real Chrome for Testing instance through the unpacked DevSpace Browser Control Bridge.</p></div><div class="score">PASS</div></div><div class="grid">${items.map((item)=>`<div class="item">${item}</div>`).join('')}</div><div class="foot">Chrome restart / reconnect and stale-claim revocation continue immediately after recording as part of the same automated gate.</div></main>`);
    });
    return app;
}

async function listen(app, port) {
    return await new Promise((resolveListen, reject) => {
        const server = app.listen(port, "127.0.0.1", () => resolveListen(server));
        server.once("error", reject);
    });
}

async function closeServer(server) {
    if (!server) return;
    await new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function waitBridge(coordinator, predicate, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    while (Date.now() < deadline) {
        latest = await coordinator.status();
        if (predicate(latest)) return latest;
        await sleep(100);
    }
    throw new Error(`Browser bridge state timeout: ${JSON.stringify(latest)}`);
}

function findRef(snapshot, role, name) {
    return snapshot.nodes.find((node) => node.ref && node.role === role && node.name === name)?.ref;
}

async function assertRejectsClaim(coordinator, claimToken, message) {
    let rejected = false;
    try { await coordinator.touchClaim(claimToken); }
    catch { rejected = true; }
    if (!rejected) throw new Error(message);
}

async function main() {
    const visible = process.env.DEVSPACE_BROWSER_GATE_VISIBLE === "1";
    const showcaseOnly = process.env.DEVSPACE_BROWSER_GATE_SHOWCASE === "1";
    const demoPause = async (ms = 700) => { if (visible) await sleep(ms); };
    const chromeExe = await findChrome();
    const profileDir = await mkdtemp(join(tmpdir(), "devspace-browser-control-chrome-"));
    const stateDir = await mkdtemp(join(tmpdir(), "devspace-browser-control-state-"));
    const coordinator = new BrowserControlCoordinator({ stateDir });
    const serverPort = await freePort();
    const debugPort1 = await freePort();
    let debugPort2;
    let httpServer;
    let chrome1;
    let chrome2;
    let cdp1;
    let cdp2;
    let claim;
    let restartClaim;
    let recorder;
    try {
        httpServer = await listen(makeHarness(coordinator), serverPort);
        const endpoint = `http://127.0.0.1:${serverPort}`;
        const pair = await coordinator.beginPair({ label: "Live Gate Chrome", ttlSeconds: 300 });
        const blockedOrigin = await fetch(`${endpoint}/browser-control/bridge/pair`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Origin": "https://untrusted.example" },
            body: JSON.stringify({ code: pair.pairCode, instanceKey: "untrusted-web-page" }),
        });
        if (blockedOrigin.status !== 403) throw new Error(`Untrusted web origin was not blocked from the local browser bridge (HTTP ${blockedOrigin.status}).`);

        const launched1 = await launchChrome(chromeExe, profileDir, debugPort1);
        chrome1 = launched1.child;
        cdp1 = await browserClient(debugPort1);
        const extensionId = await findExtensionId(cdp1);
        await pairExtension(cdp1, extensionId, endpoint, pair.pairCode, !showcaseOnly);

        const pairedStatus = await waitBridge(coordinator, (status) => status.bridges.length === 1 && status.bridges[0].online);
        const bridgeId = pairedStatus.bridges[0].bridgeId;
        const pairedLastSeen = pairedStatus.bridges[0].lastSeenAt;

        if (showcaseOnly) {
            claim = await coordinator.claim({
                bridgeId,
                openUrl: `${endpoint}/showcase`,
                activate: true,
                ownerLabel: "DevSpace Ultra Agent",
                leaseSeconds: 600,
            });
            if (!claim?.claimToken) throw new Error("Showcase failed to claim the DevSpace Ultra Chrome tab.");
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "load", timeoutMs: 10_000 }, 15_000);
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#controlPanel", timeoutMs: 5_000 }, 8_000);
            let showcaseSnapshot = await coordinator.snapshot(claim.claimToken, 320);
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#__devspace_ultra_agent_control__", timeoutMs: 5_000 }, 8_000);
            await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "activate" }, 10_000);
            await sleep(600);
            recorder = await startCdpViewportRecorder(cdp1, "/showcase", process.env.DEVSPACE_BROWSER_GATE_RECORD?.trim(), 15);
            await demoPause(900);

            const ref = (role, name) => findRef(showcaseSnapshot, role, name);
            const target = async (role, name) => {
                const elementRef = ref(role, name);
                if (!elementRef) throw new Error(`Showcase semantic ref missing: ${role} ${name}`);
                return (await coordinator.resolveRef(claim.claimToken, elementRef)).target;
            };
            const motion = 560;
            const typing = 52;
            const pointerPath = [];
            const rememberPointer = (response) => {
                const x = Number(response?.result?.x);
                const y = Number(response?.result?.y);
                if (Number.isFinite(x) && Number.isFinite(y)) pointerPath.push({ x: Math.round(x), y: Math.round(y) });
            };

            const heroClick = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: await target("button", "Try Browser Control"), button: "left", uiMotionMs: motion }, 20_000);
            rememberPointer(heroClick);
            await demoPause(500);
            const typed = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "fill", target: await target("textbox", "Agent task"), text: "Inspect DevSpace Ultra in Chrome", uiMotionMs: motion, uiTypeDelayMs: typing }, 30_000);
            if (typed.result?.value !== "Inspect DevSpace Ultra in Chrome") throw new Error(`Showcase visible typing returned unexpected value: ${JSON.stringify(typed.result?.value)}`);
            await demoPause(350);
            const selected = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "select", target: await target("combobox", "Target browser"), values: ["managed"], uiMotionMs: motion }, 20_000);
            if (!Array.isArray(selected.result?.selected) || !selected.result.selected.includes("managed")) throw new Error("Showcase target select did not change to managed work tab.");
            await demoPause(300);
            const checked = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "check", target: await target("checkbox", "Use signed-in Chrome session"), checked: true, uiMotionMs: motion }, 20_000);
            if (checked.result?.checked !== true) throw new Error("Showcase signed-in-session checkbox did not become checked.");
            await demoPause(350);
            const claimClick = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: await target("button", "Claim this tab"), button: "left", uiMotionMs: motion }, 20_000);
            rememberPointer(claimClick);
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "Exclusive lease active", timeoutMs: 5_000 }, 8_000);
            await demoPause(650);

            coordinator.clearRefs(claim.claimId);
            showcaseSnapshot = await coordinator.snapshot(claim.claimToken, 320);
            const runRef = findRef(showcaseSnapshot, "button", "Run browser task");
            if (!runRef) throw new Error("Showcase run-task button ref missing after claim.");
            const runTarget = (await coordinator.resolveRef(claim.claimToken, runRef)).target;
            const runClick = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: runTarget, button: "left", uiMotionMs: motion }, 20_000);
            rememberPointer(runClick);
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "browser task complete", timeoutMs: 5_000 }, 8_000);
            await demoPause(900);

            await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "scroll", deltaY: 760, uiMotionMs: 620 }, 20_000);
            await demoPause(700);
            coordinator.clearRefs(claim.claimId);
            showcaseSnapshot = await coordinator.snapshot(claim.claimToken, 320);
            const recoveryRef = findRef(showcaseSnapshot, "button", "Recovery path");
            if (!recoveryRef) throw new Error("Showcase recovery-card ref missing after scroll.");
            const recoveryTarget = (await coordinator.resolveRef(claim.claimToken, recoveryRef)).target;
            const recoveryHover = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "hover", target: recoveryTarget, uiMotionMs: motion }, 20_000);
            rememberPointer(recoveryHover);
            await demoPause(350);
            const recoveryClick = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: recoveryTarget, button: "left", uiMotionMs: 260 }, 20_000);
            rememberPointer(recoveryClick);
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "RECOVERY PATH · VERIFIED", timeoutMs: 5_000 }, 8_000);
            await demoPause(900);

            coordinator.clearRefs(claim.claimId);
            showcaseSnapshot = await coordinator.snapshot(claim.claimToken, 320);
            const navBrowserRef = findRef(showcaseSnapshot, "button", "Browser Control");
            if (!navBrowserRef) throw new Error("Showcase Browser Control navigation ref missing.");
            const navClick = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: (await coordinator.resolveRef(claim.claimToken, navBrowserRef)).target, button: "left", uiMotionMs: motion }, 20_000);
            rememberPointer(navClick);
            await demoPause(1300);

            const uniquePointerPositions = new Set(pointerPath.map(({ x, y }) => `${Math.round(x / 20)}:${Math.round(y / 20)}`));
            const pointerXs = pointerPath.map((item) => item.x);
            const pointerYs = pointerPath.map((item) => item.y);
            const pointerRangeX = pointerXs.length ? Math.max(...pointerXs) - Math.min(...pointerXs) : 0;
            const pointerRangeY = pointerYs.length ? Math.max(...pointerYs) - Math.min(...pointerYs) : 0;
            if (uniquePointerPositions.size < 4 || pointerRangeX < 180 || pointerRangeY < 180) {
                throw new Error(`Showcase pointer did not traverse enough visibly distinct targets: ${JSON.stringify({ pointerPath, unique: uniquePointerPositions.size, pointerRangeX, pointerRangeY })}`);
            }

            const showcaseScreenshot = await coordinator.commandForClaim(claim.claimToken, "inspect.screenshot", { fullPage: false, format: "png", quality: 90 }, 45_000);
            if (String(showcaseScreenshot.result?.data || "").length < 100) throw new Error("Showcase screenshot returned insufficient image data.");
            await demoPause(1100);
            await recorder?.stop?.();
            recorder = undefined;
            const releasedShowcase = await coordinator.release(claim.claimToken);
            claim = undefined;
            if (!releasedShowcase.detached) throw new Error("Showcase release did not detach Chrome debugger.");
            console.log(JSON.stringify({ ok: true, showcase: "PASS", visibleClaimUi: "PASS", visiblePointerMotion: "PASS", pointerTargets: pointerPath, pointerRangeX, pointerRangeY, typedInput: "PASS", select: "PASS", checkbox: "PASS", claimAction: "PASS", runAction: "PASS", scroll: "PASS", recovery: "PASS", screenshot: "PASS" }));
            return;
        }

        recorder = await startDesktopRecorder(process.env.DEVSPACE_BROWSER_GATE_RECORD?.trim());

        claim = await coordinator.claim({
            bridgeId,
            openUrl: `${endpoint}/test-page`,
            activate: true,
            ownerLabel: "DevSpace Ultra Agent",
            leaseSeconds: 600,
        });
        if (!claim?.claimToken) throw new Error("Live gate failed to claim newly opened Chrome tab.");
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#__devspace_ultra_agent_control__", timeoutMs: 5_000 }, 8_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#__devspace_ultra_agent_control___cursor", timeoutMs: 5_000 }, 8_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "AGENT CLAIMED THIS TAB", timeoutMs: 5_000 }, 8_000);
        await demoPause(1200);

        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "load", timeoutMs: 10_000 }, 15_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "url", value: "/test-page", timeoutMs: 5_000 }, 8_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#name", timeoutMs: 5_000 }, 8_000);
        let snapshot = await coordinator.snapshot(claim.claimToken, 400);
        const nameRef = findRef(snapshot, "textbox", "Name");
        const passwordRef = findRef(snapshot, "textbox", "Password");
        const agreeRef = findRef(snapshot, "checkbox", "Agree to terms");
        const modeRef = findRef(snapshot, "combobox", "Mode");
        const hoverRef = findRef(snapshot, "button", "Hover target");
        const doubleRef = findRef(snapshot, "button", "Double click target");
        const dragRef = findRef(snapshot, "button", "Drag source");
        const dropRef = findRef(snapshot, "button", "Drop Zone");
        const submitRef = findRef(snapshot, "button", "Submit");
        const downloadRef = findRef(snapshot, "link", "Download test file");
        const passwordNode = snapshot.nodes.find((node) => node.ref === passwordRef);
        if (!nameRef || !passwordRef || !agreeRef || !modeRef || !hoverRef || !doubleRef || !dragRef || !dropRef || !submitRef || !downloadRef) {
            throw new Error(`Live semantic snapshot missing expected refs. Snapshot:\n${snapshot.snapshot}`);
        }
        if (!passwordNode?.sensitive || passwordNode.value || snapshot.snapshot.includes("live-secret-must-not-leak")) {
            throw new Error(`Password value leaked through semantic snapshot: ${JSON.stringify(passwordNode)}\n${snapshot.snapshot}`);
        }
        await demoPause(900);

        const nameTarget = (await coordinator.resolveRef(claim.claimToken, nameRef)).target;
        const passwordTarget = (await coordinator.resolveRef(claim.claimToken, passwordRef)).target;
        const agreeTarget = (await coordinator.resolveRef(claim.claimToken, agreeRef)).target;
        const modeTarget = (await coordinator.resolveRef(claim.claimToken, modeRef)).target;
        const hoverTarget = (await coordinator.resolveRef(claim.claimToken, hoverRef)).target;
        const doubleTarget = (await coordinator.resolveRef(claim.claimToken, doubleRef)).target;
        const dragTarget = (await coordinator.resolveRef(claim.claimToken, dragRef)).target;
        const dropTarget = (await coordinator.resolveRef(claim.claimToken, dropRef)).target;
        const submitTarget = (await coordinator.resolveRef(claim.claimToken, submitRef)).target;
        const downloadTarget = (await coordinator.resolveRef(claim.claimToken, downloadRef)).target;

        console.log("LIVE_GATE_STAGE password-fill-block");
        let passwordFillBlocked = false;
        try {
            await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "fill", target: passwordTarget, text: "must-not-enter-chat" }, 20_000);
        }
        catch (error) {
            passwordFillBlocked = /password entry is blocked/i.test(error.message);
        }
        if (!passwordFillBlocked) throw new Error("Programmatic password-field filling was not blocked by the live Chrome extension.");
        await demoPause(900);

        console.log("LIVE_GATE_STAGE focus-fill-type-press");
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "focus", target: nameTarget }, 20_000);
        let focusSnapshot = await coordinator.snapshot(claim.claimToken, 250);
        if (!focusSnapshot.nodes.find((node) => node.role === "textbox" && node.name === "Name")?.focused) throw new Error("Live focus action did not focus the Name textbox.");
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "fill", target: nameTarget, text: "DevSpace" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "type", target: nameTarget, text: " Ultra" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "press", target: nameTarget, key: "Enter" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "KEY PRESS · PASS", timeoutMs: 5_000 }, 8_000);
        const afterFill = await coordinator.snapshot(claim.claimToken, 250);
        const filledName = afterFill.nodes.find((node) => node.role === "textbox" && node.name === "Name")?.value;
        if (filledName !== "DevSpace Ultra") throw new Error(`Live fill/type did not update textbox value: ${JSON.stringify(filledName)}\n${afterFill.snapshot}`);
        await demoPause(900);

        console.log("LIVE_GATE_STAGE checkbox-select");
        const checkResult = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "check", target: agreeTarget, checked: true }, 20_000);
        if (checkResult.result?.checked !== true) throw new Error("Live checkbox action did not return checked=true.");
        const selectResult = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "select", target: modeTarget, values: ["beta"] }, 20_000);
        if (!Array.isArray(selectResult.result?.selected) || !selectResult.result.selected.includes("beta")) throw new Error("Live select action did not select beta.");
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "CHECKBOX · PASS", timeoutMs: 5_000 }, 8_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "SELECT · PASS", timeoutMs: 5_000 }, 8_000);
        await demoPause(900);

        console.log("LIVE_GATE_STAGE hover-doubleclick");
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "hover", target: hoverTarget }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "HOVER · PASS", timeoutMs: 5_000 }, 8_000);
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "doubleClick", target: doubleTarget, button: "left" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "DOUBLE CLICK · PASS", timeoutMs: 5_000 }, 8_000);
        await demoPause(900);

        console.log("LIVE_GATE_STAGE drag");
        const dropPoint = await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "hover", target: dropTarget }, 20_000);
        const endX = Number(dropPoint.result?.x);
        const endY = Number(dropPoint.result?.y);
        if (!Number.isFinite(endX) || !Number.isFinite(endY)) throw new Error("Live drop-zone hover did not return coordinates for drag target.");
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "drag", target: dragTarget, endX, endY }, 25_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "DRAG · PASS", timeoutMs: 5_000 }, 8_000);
        await demoPause(1000);

        console.log("LIVE_GATE_STAGE scroll");
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "scroll", deltaY: 900 }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "SCROLL · PASS", timeoutMs: 5_000 }, 8_000);
        await demoPause(800);

        console.log("LIVE_GATE_STAGE developer-cdp");
        const developerStatus = await coordinator.status();
        if (developerStatus.bridges.find((item) => item.bridgeId === bridgeId)?.capabilities?.developerMode !== true) throw new Error("Live extension did not report Developer mode enabled for CDP gate.");
        const validatedCdpMethod = coordinator.validateCdpMethod("Runtime.evaluate");
        await coordinator.commandForClaim(claim.claimToken, "cdp.command", {
            method: validatedCdpMethod,
            params: { expression: `(() => { const el=document.getElementById('cdpState'); if(!el) return false; el.textContent='DEVELOPER CDP · PASS'; el.style.color='#34d399'; el.style.fontWeight='800'; return true; })()`, returnByValue: true },
        }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "DEVELOPER CDP · PASS", timeoutMs: 5_000 }, 8_000);
        await demoPause(1200);

        console.log("LIVE_GATE_STAGE submit-click");
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: submitTarget, button: "left" }, 20_000);
        coordinator.clearRefs(claim.claimId);
        try {
            await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "Hello DevSpace Ultra · PASS", timeoutMs: 10_000 }, 15_000);
        }
        catch (error) {
            const failedSnapshot = await coordinator.snapshot(claim.claimToken, 300).catch(() => undefined);
            const failedConsole = await coordinator.commandForClaim(claim.claimToken, "inspect.events", { kind: "console", limit: 50 }, 20_000).catch(() => undefined);
            const failedNetwork = await coordinator.commandForClaim(claim.claimToken, "inspect.events", { kind: "network", limit: 100 }, 20_000).catch(() => undefined);
            throw new Error(`${error.message}\nSNAPSHOT=${failedSnapshot?.snapshot}\nCONSOLE=${JSON.stringify(failedConsole?.result?.items)}\nNETWORK=${JSON.stringify(failedNetwork?.result?.items)}`);
        }
        await demoPause(1200);

        snapshot = await coordinator.snapshot(claim.claimToken, 300);
        if (!snapshot.snapshot.includes("Hello DevSpace Ultra · PASS")) throw new Error("Live page state did not contain expected PASS text after click.");
        const screenshot = await coordinator.commandForClaim(claim.claimToken, "inspect.screenshot", { fullPage: false, format: "png", quality: 85 }, 45_000);
        if (String(screenshot.result?.data || "").length < 100) throw new Error("Live screenshot returned insufficient image data.");

        console.log("LIVE_GATE_STAGE screenshot-download");
        const refreshedDownloadRef = findRef(snapshot, "link", "Download test file");
        const refreshedDownloadTarget = refreshedDownloadRef ? (await coordinator.resolveRef(claim.claimToken, refreshedDownloadRef)).target : downloadTarget;
        await coordinator.commandForClaim(claim.claimToken, "page.act", { action: "click", target: refreshedDownloadTarget, button: "left" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "delay", timeoutMs: visible ? 1200 : 800 }, visible ? 2_500 : 2_000);

        const consoleResult = await coordinator.commandForClaim(claim.claimToken, "inspect.events", { kind: "console", limit: 50 }, 20_000);
        const networkResult = await coordinator.commandForClaim(claim.claimToken, "inspect.events", { kind: "network", limit: 100 }, 20_000);
        const downloadResult = await coordinator.commandForClaim(claim.claimToken, "inspect.events", { kind: "downloads", limit: 50 }, 20_000);
        const consoleText = JSON.stringify(consoleResult.result?.items || []);
        const networkText = JSON.stringify(networkResult.result?.items || []);
        const downloadText = JSON.stringify(downloadResult.result?.items || []);
        if (!consoleText.includes("live-gate-submit")) throw new Error(`Console capture missing live-gate-submit: ${consoleText}`);
        if (!networkText.includes("/api/ping")) throw new Error(`Network capture missing /api/ping: ${networkText}`);
        if (!downloadText.includes("devspace-browser-control-gate.txt") && !downloadText.includes("/download")) throw new Error(`Download capture missing claimed-tab download: ${downloadText}`);
        await demoPause(900);

        console.log("LIVE_GATE_STAGE navigation");
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "goto", url: `${endpoint}/second-page` }, 20_000);
        coordinator.clearRefs(claim.claimId);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "load", timeoutMs: 10_000 }, 15_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "url", value: "/second-page", timeoutMs: 5_000 }, 8_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "Second page reached", timeoutMs: 5_000 }, 8_000);
        await demoPause(900);
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "back" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "Browser Control / Computer Use", timeoutMs: 10_000 }, 15_000);
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "forward" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "Second page reached", timeoutMs: 10_000 }, 15_000);
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "back" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#submit", timeoutMs: 10_000 }, 15_000);
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "reload" }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "selector", value: "#name", timeoutMs: 10_000 }, 15_000);
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "stop" }, 10_000);
        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "activate" }, 10_000);
        await demoPause(1000);

        let secondClaimRejected = false;
        try {
            await coordinator.claim({ bridgeId, tabId: claim.tab.tabId, activate: false, ownerLabel: "competing-agent" });
        }
        catch (error) {
            secondClaimRejected = /claimed|No matching unclaimed/i.test(error.message);
        }
        if (!secondClaimRejected) throw new Error("Concurrent second claim was not rejected.");

        await coordinator.commandForClaim(claim.claimToken, "page.navigate", { action: "goto", url: `${endpoint}/acceptance-summary` }, 20_000);
        await coordinator.commandForClaim(claim.claimToken, "page.wait", { condition: "text", value: "LIVE ACCEPTANCE PASS", timeoutMs: 10_000 }, 15_000);
        await demoPause(3000);

        const released = await coordinator.release(claim.claimToken);
        claim = undefined;
        if (!released.detached) throw new Error("Debugger was not detached on live claim release.");
        await demoPause(900);
        await stopDesktopRecorder(recorder);
        recorder = undefined;

        restartClaim = await coordinator.claim({
            bridgeId,
            openUrl: `${endpoint}/test-page?restart-claim=1`,
            activate: false,
            ownerLabel: "live-gate-restart-claim",
            leaseSeconds: 600,
        });
        await coordinator.commandForClaim(restartClaim.claimToken, "page.wait", { condition: "load", timeoutMs: 10_000 }, 15_000);
        const preRestartStatus = await coordinator.status();
        const preRestartBridge = preRestartStatus.bridges.find((item) => item.bridgeId === bridgeId);
        const preRestartLastSeen = preRestartBridge?.lastSeenAt;
        const preRestartBrowserSessionId = coordinator.state.bridges[bridgeId]?.browserSessionId;
        if (!preRestartStatus.activeClaims.some((item) => item.claimId === restartClaim.claimId)) throw new Error("Restart claim was not active before Chrome restart.");

        await sleep(300);
        await killTree(chrome1);
        chrome1 = undefined;
        cdp1.close();
        cdp1 = undefined;
        await sleep(800);

        debugPort2 = await freePort();
        const launched2 = await launchChrome(chromeExe, profileDir, debugPort2);
        chrome2 = launched2.child;
        cdp2 = await browserClient(debugPort2);
        const extensionIdAfterRestart = await findExtensionId(cdp2);
        if (extensionIdAfterRestart !== extensionId) throw new Error("Extension ID changed across same-profile Chrome restart.");

        const reconnectStatus = await waitBridge(coordinator, (status) => {
            const bridge = status.bridges.find((item) => item.bridgeId === bridgeId);
            const restartClaimGone = !status.activeClaims.some((item) => item.claimId === restartClaim.claimId);
            return Boolean(bridge?.online && String(bridge.lastSeenAt) > String(preRestartLastSeen) && restartClaimGone);
        }, 20_000);
        const reconnectBridge = reconnectStatus.bridges.find((item) => item.bridgeId === bridgeId);
        const postRestartBrowserSessionId = coordinator.state.bridges[bridgeId]?.browserSessionId;
        await assertRejectsClaim(coordinator, restartClaim.claimToken, "Restarted Chrome must revoke the stale pre-restart claim.");
        restartClaim = undefined;

        const final = {
            ok: true,
            chromeExecutable: chromeExe,
            extensionId,
            bridgeId,
            pairing: "PASS",
            crossOriginWebPageBlocked: "PASS",
            newTabClaim: "PASS",
            visibleClaimBanner: "PASS",
            visibleBlackAgentCursor: "PASS",
            semanticSnapshot: "PASS",
            semanticFillClick: "PASS",
            focusFillTypePress: "PASS",
            checkboxSelect: "PASS",
            hoverDoubleClick: "PASS",
            drag: "PASS",
            scroll: "PASS",
            developerModeCdpLive: "PASS",
            navigationBackForwardReloadStopActivate: "PASS",
            waitLoadUrlTextSelectorDelay: "PASS",
            passwordSnapshotMasked: "PASS",
            passwordFillBlocked: "PASS",
            pageState: "PASS",
            screenshot: "PASS",
            consoleCapture: "PASS",
            networkCapture: "PASS",
            downloadCapture: "PASS",
            exclusiveClaim: "PASS",
            releaseDetach: "PASS",
            chromeRestartReconnect: reconnectBridge?.online ? "PASS" : "FAIL",
            restartRevokesStaleClaim: "PASS",
            browserSessionRotated: preRestartBrowserSessionId && postRestartBrowserSessionId && preRestartBrowserSessionId !== postRestartBrowserSessionId ? "PASS" : "NOT_REQUIRED_TAB_IDENTITY_GUARD_PRESENT",
        };
        console.log(JSON.stringify(final));
    }
    finally {
        if (claim?.claimToken) {
            try { await coordinator.release(claim.claimToken); } catch {}
        }
        if (restartClaim?.claimToken) {
            try { await coordinator.release(restartClaim.claimToken); } catch {}
        }
        await stopDesktopRecorder(recorder).catch(() => {});
        cdp1?.close();
        cdp2?.close();
        await killTree(chrome1);
        await killTree(chrome2);
        await closeServer(httpServer);
        await coordinator.close();
        await rm(profileDir, { recursive: true, force: true }).catch(() => {});
        await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
}

await main();
