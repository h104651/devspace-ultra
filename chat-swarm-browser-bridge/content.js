(() => {
  const INSTANCE_KEY = "__CHAT_SWARM_WAKE_BRIDGE_018__";
  if (globalThis[INSTANCE_KEY]) return;
  globalThis[INSTANCE_KEY] = true;

  let baseUrl = null;
  const BIND_RE = /\[\[CHAT_SWARM_BIND:([A-Za-z0-9_-]{16,128})\]\]/;
  const INVITE_RE = /invite\s*code\s*[:：]\s*`?([A-Fa-f0-9]{12,64})`?/i;
  const JOIN_BROWSER_RE = /chat[_\s-]*swarm[_\s-]*join[_\s-]*browser/i;
  const AUTO_JOIN_RE = /\[CHAT_SWARM_BROWSER_AUTO\]/i;
  const STORAGE_PREFIX = "chatSwarmWake:";

  let streamAbort = null;
  let boundToken = null;
  let boundWorkerId = null;
  let boundWorkerToken = null;
  let joinInFlight = false;
  const pageInstanceKey = `${location.origin}${location.pathname}#${crypto.randomUUID()}`;
  let lastWakeTaskId = null;
  let lastWakeAt = 0;
  let reconnectDelay = 1000;
  let indicator;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeBaseUrl(value) {
    const raw = String(value || "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("Configure the DevSpace base URL in the extension popup first.");
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error("DevSpace base URL must use HTTPS or local HTTP.");
    const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !localHttp) throw new Error("Non-local DevSpace URLs must use HTTPS.");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("DevSpace base URL cannot contain credentials, query parameters, or a fragment.");
    return raw;
  }

  async function getBaseUrl() {
    if (baseUrl) return baseUrl;
    const saved = await chrome.storage.local.get(['devspaceBaseUrl']);
    baseUrl = normalizeBaseUrl(saved.devspaceBaseUrl);
    return baseUrl;
  }

  const pageKey = () => STORAGE_PREFIX + "binding";
  const rawPageKey = () => pageInstanceKey;
  const wakeMessage = (task) => `[CHAT_SWARM_WAKE] A task is already claimed for this browser worker. Do NOT call chat_swarm_claim. Worker token: ${boundWorkerToken}. Task ID: ${task.taskId}.\n\nTASK:\n${task.prompt}\n\nComplete this task fully, then call chat_swarm_submit_once exactly once with workerToken ${boundWorkerToken}, taskId ${task.taskId}, status completed, and the complete task result in result. Do not report the result, progress, or completion to the user. After chat_swarm_submit_once returns, end this turn immediately. The browser wake bridge will remain parked for later work.`;

  function ensureIndicator() {
    if (indicator?.isConnected) return indicator;
    indicator = document.createElement("div");
    indicator.id = "chat-swarm-wake-indicator";
    Object.assign(indicator.style, {
      position: "fixed",
      right: "14px",
      bottom: "14px",
      zIndex: "2147483647",
      padding: "6px 9px",
      borderRadius: "999px",
      font: "12px/1.2 system-ui, sans-serif",
      background: "rgba(20,20,20,.86)",
      color: "white",
      boxShadow: "0 2px 10px rgba(0,0,0,.25)",
      pointerEvents: "none",
      opacity: ".86"
    });
    indicator.textContent = "Swarm bridge: unbound";
    document.documentElement.appendChild(indicator);
    return indicator;
  }

  function setIndicator(text) {
    ensureIndicator().textContent = text;
  }

  async function storageGet(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  async function storageSet(key, value) {
    sessionStorage.setItem(key, JSON.stringify(value));
  }

  async function storageRemove(key) {
    sessionStorage.removeItem(key);
  }

  async function clearBinding() {
    streamAbort?.abort();
    streamAbort = null;
    boundToken = null;
    boundWorkerId = null;
    boundWorkerToken = null;
    reconnectDelay = 1000;
    await storageRemove(pageKey());
  }

  async function bindCode(code) {
    if (!code || boundToken) return;
    setIndicator("Swarm bridge: binding…");
    const response = await fetch(`${await getBaseUrl()}/chat-swarm/browser-bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`bind HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.browserWakeToken) throw new Error("bind response missing browserWakeToken");
    boundToken = data.browserWakeToken;
    boundWorkerId = data.workerId || "worker";
    await storageSet(pageKey(), { browserWakeToken: boundToken, workerId: boundWorkerId, workerToken: boundWorkerToken });
    setIndicator(`Swarm ${boundWorkerId}: parked`);
    startStream();
  }

  async function bindInviteExisting(inviteCode) {
    if (!inviteCode || boundToken) return;
    setIndicator("Swarm bridge: auto-binding…");
    const response = await fetch(`${await getBaseUrl()}/chat-swarm/browser-bind-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode }),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`invite bind HTTP ${response.status}`);
    const data = await response.json();
    boundToken = data.browserWakeToken;
    boundWorkerId = data.workerId || "worker";
    await storageSet(pageKey(), { browserWakeToken: boundToken, workerId: boundWorkerId, workerToken: boundWorkerToken });
    setIndicator(`Swarm ${boundWorkerId}: parked`);
    startStream();
  }

  async function directJoinInvite(inviteCode) {
    if (!inviteCode) throw new Error("Invite code is required.");
    if (boundToken) return { workerId: boundWorkerId, alreadyBound: true };
    if (joinInFlight) throw new Error("Worker join already in progress.");
    joinInFlight = true;
    try {
      setIndicator("Swarm bridge: joining…");
      const response = await fetch(`${await getBaseUrl()}/chat-swarm/browser-direct-join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode, pageKey: rawPageKey() }),
        cache: "no-store"
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `direct join HTTP ${response.status}`);
      }
      const data = await response.json();
      boundToken = data.browserWakeToken;
      boundWorkerId = data.workerId || "worker";
      boundWorkerToken = data.workerToken || null;
      await storageSet(pageKey(), { browserWakeToken: boundToken, workerId: boundWorkerId, workerToken: boundWorkerToken });
      setIndicator(`Swarm ${boundWorkerId}: parked`);
      startStream();
      return { workerId: boundWorkerId, alreadyBound: false };
    } finally {
      joinInFlight = false;
    }
  }

  function scanForBindMarker(root = document.body) {
    if (!root || boundToken) return;
    const text = root.innerText || root.textContent || "";
    const marker = text.match(BIND_RE);
    if (marker) {
      void bindCode(marker[1]).catch((error) => setIndicator(`Swarm bind failed: ${error.message}`));
      return;
    }
    // Manual activation only in v0.1.7. Visible ChatGPT prompts are ignored so
    // the model cannot race the bridge or report a false-positive worker join.
  }

  function isGenerating() {
    return Boolean(
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop"]') ||
      document.querySelector('button[aria-label*="停止"]')
    );
  }

  function findComposer() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('[data-testid="composer-input"]') ||
      document.querySelector('textarea[placeholder]') ||
      [...document.querySelectorAll('[contenteditable="true"]')].find((el) => el.offsetParent !== null)
    );
  }

  function composerText(el) {
    if (!el) return "";
    if ("value" in el) return String(el.value || "").trim();
    return String(el.innerText || el.textContent || "").trim();
  }

  function setComposerText(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {}
    if (!inserted) {
      el.replaceChildren(document.createTextNode(text));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="傳送"]',
      'button[aria-label*="发送"]'
    ];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button && button.offsetParent !== null && !button.disabled) return button;
    }
    return null;
  }

  async function sendWake(taskId) {
    const now = Date.now();
    if (taskId === lastWakeTaskId && now - lastWakeAt < 60000) return;
    lastWakeTaskId = taskId;
    lastWakeAt = now;
    setIndicator(`Swarm ${boundWorkerId}: claiming`);

    let claim;
    try {
      const response = await fetch(`${await getBaseUrl()}/chat-swarm/browser-claim`, {
        method: "POST",
        headers: { "X-Chat-Swarm-Browser-Token": boundToken },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`claim HTTP ${response.status}`);
      claim = await response.json();
    } catch (error) {
      lastWakeTaskId = null;
      setIndicator(`Swarm ${boundWorkerId}: claim failed`);
      return;
    }

    if (claim?.state !== "task" || !claim?.task?.taskId) {
      lastWakeTaskId = null;
      setIndicator(`Swarm ${boundWorkerId}: parked`);
      return;
    }

    const task = claim.task;
    setIndicator(`Swarm ${boundWorkerId}: task ready`);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (isGenerating()) {
        await sleep(1000);
        continue;
      }
      const composer = findComposer();
      if (!composer) {
        await sleep(1000);
        continue;
      }
      if (composerText(composer)) {
        await sleep(1000);
        continue;
      }
      setComposerText(composer, wakeMessage(task));
      await sleep(250);
      const send = findSendButton();
      if (send) {
        send.click();
        setIndicator(`Swarm ${boundWorkerId}: working`);
        return;
      }
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      await sleep(500);
      if (isGenerating() || !composerText(composer)) {
        setIndicator(`Swarm ${boundWorkerId}: working`);
        return;
      }
      await sleep(1000);
    }
    setIndicator(`Swarm ${boundWorkerId}: wake blocked`);
  }

  async function consumeStream(token, signal) {
    const response = await fetch(`${await getBaseUrl()}/chat-swarm/browser-events`, {
      method: "GET",
      headers: { "X-Chat-Swarm-Browser-Token": token },
      cache: "no-store",
      signal
    });
    if (!response.ok || !response.body) {
      const error = new Error(`events HTTP ${response.status}`);
      error.authInvalid = response.status === 401 || response.status === 403;
      throw error;
    }
    reconnectDelay = 1000;
    setIndicator(`Swarm ${boundWorkerId}: parked`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("event stream ended");
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        let event;
        try { event = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (event.type === "task_available") void sendWake(event.taskId);
        else if (event.type === "busy") setIndicator(`Swarm ${boundWorkerId}: working`);
        else if (event.type === "parked") setIndicator(`Swarm ${boundWorkerId}: parked`);
        else if (event.type === "closed") {
          setIndicator(`Swarm ${boundWorkerId}: closed`);
          return;
        }
      }
    }
  }

  async function streamLoop(token) {
    while (boundToken === token) {
      const controller = new AbortController();
      streamAbort = controller;
      try {
        await consumeStream(token, controller.signal);
        return;
      } catch (error) {
        if (controller.signal.aborted || boundToken !== token) return;
        if (error?.authInvalid) {
          await clearBinding();
          setIndicator("Swarm bridge: rebinding…");
          scanForBindMarker(document.body);
          return;
        }
        setIndicator(`Swarm ${boundWorkerId}: reconnecting`);
        const jitter = Math.floor(Math.random() * 400);
        await sleep(reconnectDelay + jitter);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    }
  }

  function startStream() {
    streamAbort?.abort();
    if (!boundToken) return;
    void streamLoop(boundToken);
  }

  async function restoreBinding() {
    const saved = await storageGet(pageKey());
    if (!saved?.browserWakeToken) return;
    boundToken = saved.browserWakeToken;
    boundWorkerId = saved.workerId || "worker";
    boundWorkerToken = saved.workerToken || null;
    setIndicator(`Swarm ${boundWorkerId}: reconnecting`);
    startStream();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "chat-swarm-activate") return false;
    try {
      if (message.baseUrl) baseUrl = normalizeBaseUrl(message.baseUrl);
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
      return false;
    }
    void directJoinInvite(String(message.inviteCode || "").trim())
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        setIndicator(`Swarm join failed: ${error.message}`);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  });

  setIndicator("Swarm bridge: injected");
  void restoreBinding();
  scanForBindMarker();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        scanForBindMarker(document.body);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
