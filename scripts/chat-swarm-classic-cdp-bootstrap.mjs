function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const port = Number(arg("port", "0"));
const invite = String(arg("invite", "")).trim();
const label = String(arg("label", "Runtime")).trim();
const probeOnly = process.argv.includes("--probe");
const dismissOnly = process.argv.includes("--dismiss-only");
const interruptOnly = process.argv.includes("--interrupt-only");
const compactOutput = process.argv.includes("--compact");
const newChat = process.argv.includes("--new-chat");
const minimalPrompt = process.argv.includes("--minimal");
const resumeWorker = process.argv.includes("--resume");
const conversationUrl = String(arg("conversation-url", "")).trim();
const projectUrl = String(arg("project-url", "")).trim();
const customPrompt = String(arg("custom-prompt", "")).trim();

if (!Number.isInteger(port) || port <= 0) {
  console.error("A valid --port is required.");
  process.exit(2);
}
if (!probeOnly && !dismissOnly && !interruptOnly && !resumeWorker && !invite && !customPrompt) {
  console.error("--invite or --custom-prompt is required unless --probe, --dismiss-only, --interrupt-only, or --resume is used.");
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(path) {
  const response = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return await response.json();
}

async function findPage(deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = await json("/json/list");
      let targets = (Array.isArray(last) ? last : []).filter(
        (entry) =>
          (entry.type === "page" || entry.type === "webview" || entry.type === "iframe") &&
          entry.webSocketDebuggerUrl
      );
      if (targets.length === 0) {
        try {
          const res = await fetch(`${base}/json/new?https://chatgpt.com/`, { method: "PUT" });
          if (res.ok) {
            const created = await res.json();
            if (created && created.webSocketDebuggerUrl) {
              targets = [created];
            }
          }
        } catch {}
      }
      const preferred =
        targets.find((entry) => /chatgpt\.com/i.test(entry.url || "")) ||
        targets.find((entry) => entry.type === "page") ||
        targets[0];
      if (preferred) return preferred;
    } catch {}
    await sleep(500);
  }
  throw new Error(`No inspectable page found on CDP port ${port}. Targets: ${JSON.stringify(last.map((x) => ({ type: x.type, url: x.url })))}`);
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (event) => {
        this.ws.removeEventListener("open", onOpen);
        reject(event?.error || new Error("WebSocket connection failed"));
      };
      this.ws.addEventListener("open", onOpen, { once: true });
      this.ws.addEventListener("error", onError, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 750);
      try { this.ws.addEventListener("close", finish, { once: true }); } catch {}
      try { this.ws.close(); } catch { finish(); }
    });
  }
}

function expressionForProbe() {
  return String.raw`(() => {
    const composer = document.querySelector('#prompt-textarea') ||
      document.querySelector('[data-testid="composer-input"]') ||
      document.querySelector('textarea[placeholder]') ||
      [...document.querySelectorAll('[contenteditable="true"]')].find((el) => el.offsetParent !== null);
    const bodyText = String(document.body?.innerText || '');
    const login = [...document.querySelectorAll('button,a')].some((el) => /^(log in|登入)$/i.test((el.innerText || el.textContent || '').trim()));
    const throttled = /too many requests|try again later|太多要求|過於頻繁|請稍等幾分鐘後再試/i.test(bodyText);
    const connectionInterrupted = /connection interrupted|waiting for (?:the )?complete response|連線中斷|等待完整回覆/i.test(bodyText);
    const composerText = composer ? ('value' in composer ? String(composer.value || '') : String(composer.innerText || composer.textContent || '')) : '';
    const sendButton = document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      [...document.querySelectorAll('button')].find((el) => /send|傳送|发送/i.test(el.getAttribute('aria-label') || ''));
    const recentChats = [...document.querySelectorAll('a[href*="/c/"]')]
      .map((el) => ({ href: el.getAttribute('href') || '', text: (el.innerText || el.textContent || '').trim() }))
      .filter((item) => item.href)
      .slice(0, 20);
    const projectLinks = [...document.querySelectorAll('a[href*="/g/g-p-"]')]
      .map((el) => ({ href: el.getAttribute('href') || '', text: (el.innerText || el.textContent || '').trim() }))
      .filter((item, index, all) => item.href && all.findIndex((other) => other.href === item.href && other.text === item.text) === index)
      .slice(0, 30);
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      composer: !!composer,
      composerDisabled: composer ? !!composer.disabled || composer.getAttribute('aria-disabled') === 'true' : null,
      composerTextLength: composerText.trim().length,
      sendButton: !!sendButton,
      sendButtonDisabled: sendButton ? !!sendButton.disabled : null,
      loginVisible: login,
      throttled,
      connectionInterrupted,
      generating: !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]'),
      textLength: bodyText.length,
      bodyPreview: bodyText.slice(-900),
      recentChats,
      projectLinks
    };
  })()`;
}

function compactProbe(probe) {
  if (!probe || !compactOutput) return probe;
  return {
    href: probe.href,
    readyState: probe.readyState,
    composer: probe.composer,
    composerDisabled: probe.composerDisabled,
    composerTextLength: probe.composerTextLength,
    loginVisible: probe.loginVisible,
    throttled: probe.throttled,
    connectionInterrupted: probe.connectionInterrupted,
    generating: probe.generating,
  };
}

function compactDismiss(value) {
  if (!value || !compactOutput) return value;
  return { detected: !!value.detected, clicked: !!value.clicked };
}

function expressionForDismissThrottle() {
  return String.raw`(() => {
    const bodyText = String(document.body?.innerText || '');
    const throttleRe = /too many requests|try again later|太多要求|過於頻繁|請稍等幾分鐘後再試/i;
    if (!throttleRe.test(bodyText)) return { detected: false, clicked: false };

    const candidates = [...document.querySelectorAll('[role="dialog"], [data-state="open"], body')];
    for (const container of candidates) {
      const text = String(container.innerText || container.textContent || '');
      if (!throttleRe.test(text)) continue;
      const button = [...container.querySelectorAll('button')].find((el) => {
        const label = String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        return /^(知道了|got it|ok|okay|dismiss|close|關閉)$/i.test(label) && !el.disabled;
      });
      if (button) {
        button.click();
        return { detected: true, clicked: true, label: String(button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim() };
      }
    }
    return { detected: true, clicked: false };
  })()`;
}

function expressionForNewChat() {
  return String.raw`(() => {
    const candidates = [
      document.querySelector('[data-testid="create-new-chat-button"]'),
      document.querySelector('a[href="/"]'),
      ...[...document.querySelectorAll('button,a')].filter((el) => /new chat|新對話|新增對話|新聊天/i.test((el.innerText || el.textContent || '').trim()))
    ].filter(Boolean);
    const visible = candidates.find((el) => el.offsetParent !== null);
    if (!visible) return { ok: false, reason: 'new-chat-control-not-found' };
    visible.click();
    return { ok: true };
  })()`;
}

function expressionForInsert(prompt) {
  const serialized = JSON.stringify(prompt);
  return `(() => {
    const text = ${serialized};
    const composer = document.querySelector('#prompt-textarea') ||
      document.querySelector('[data-testid="composer-input"]') ||
      document.querySelector('textarea[placeholder]') ||
      [...document.querySelectorAll('[contenteditable="true"]')].find((el) => el.offsetParent !== null);
    if (!composer) return { ok: false, reason: 'composer-not-found', href: location.href };
    if (composer.disabled || composer.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'composer-disabled' };
    composer.focus();
    if ('value' in composer) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, text); else composer.value = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch {}
      if (!inserted) {
        composer.replaceChildren(document.createTextNode(text));
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }
    return { ok: true, textLength: text.length };
  })()`;
}

function expressionForStopClick() {
  return String.raw`(() => {
    const stop = document.querySelector('button[data-testid="stop-button"]') ||
      [...document.querySelectorAll('button')].find((el) => /stop|停止/i.test(el.getAttribute('aria-label') || ''));
    if (!stop) return { detected: false, clicked: false };
    if (stop.disabled) return { detected: true, clicked: false, disabled: true };
    stop.click();
    return { detected: true, clicked: true };
  })()`;
}

function expressionForSendClick() {
  return String.raw`(() => {
    const send = document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      [...document.querySelectorAll('button')].find((el) => /send|傳送|发送/i.test(el.getAttribute('aria-label') || ''));
    if (!send) return { ok: false, reason: 'send-button-not-found' };
    if (send.disabled) return { ok: false, reason: 'send-button-disabled' };
    send.click();
    return { ok: true };
  })()`;
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function waitForComposer(client, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(client, expressionForProbe());
    if (last?.composer && !last?.composerDisabled) return last;
    await sleep(600);
  }
  throw new Error(`Composer did not become ready: ${JSON.stringify(last)}`);
}

async function run() {
const page = await findPage();
const client = new CdpClient(page.webSocketDebuggerUrl);
try {
  await client.open();
  await client.call("Runtime.enable");
  await client.call("Page.enable");

  if (conversationUrl) {
    const target = new URL(conversationUrl);
    const safeConversation = /^\/c\//.test(target.pathname) || /^\/g\/g-p-[^/]+\/c\//.test(target.pathname);
    if (target.protocol !== "https:" || target.hostname !== "chatgpt.com" || !safeConversation) {
      throw new Error(`Unsafe --conversation-url: ${conversationUrl}`);
    }
    await client.call("Page.navigate", { url: target.toString() });
    await sleep(2500);
    try { await client.call("Runtime.enable"); } catch {}
  } else if (projectUrl) {
    const target = new URL(projectUrl);
    if (target.protocol !== "https:" || target.hostname !== "chatgpt.com" || !/^\/g\/g-p-[^/]+\/project\/?$/.test(target.pathname)) {
      throw new Error(`Unsafe --project-url: ${projectUrl}`);
    }
    await client.call("Page.navigate", { url: target.toString() });
    await sleep(2500);
    try { await client.call("Runtime.enable"); } catch {}
  }

  let probe = await evaluate(client, expressionForProbe());
  if (probe?.loginVisible) {
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      probe = await evaluate(client, expressionForProbe());
      if (!probe?.loginVisible && probe?.composer) break;
    }
  }
  if (probeOnly) {
    console.log(JSON.stringify({ ok: true, port, page: compactOutput ? { url: page.url } : { url: page.url, title: page.title }, probe: compactProbe(probe) }));
    return;
  }
  if (dismissOnly) {
    const dismissed = probe?.throttled ? await evaluate(client, expressionForDismissThrottle()) : { detected: false, clicked: false };
    await sleep(250);
    const afterDismiss = await evaluate(client, expressionForProbe());
    console.log(JSON.stringify({ ok: true, port, label, dismissed: compactDismiss(dismissed), afterDismiss: compactProbe(afterDismiss) }));
    return;
  }
  if (interruptOnly) {
    const interrupted = await evaluate(client, expressionForStopClick());
    let afterInterrupt;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      afterInterrupt = await evaluate(client, expressionForProbe());
      if (!afterInterrupt?.generating) break;
    }
    console.log(JSON.stringify({ ok: true, port, label, interrupted, afterInterrupt: compactProbe(afterInterrupt) }));
    return;
  }

  if (probe?.loginVisible) {
    throw new Error(`Runtime ${label} appears logged out; auto-join is unsafe until login provisioning is complete.`);
  }
  let preSendDismissed;
  if (probe?.throttled) {
    preSendDismissed = await evaluate(client, expressionForDismissThrottle());
    await sleep(400);
  }

  if (newChat) {
    await evaluate(client, expressionForNewChat());
    await sleep(1200);
  }
  await waitForComposer(client);

  const prompt = customPrompt
    ? customPrompt
    : resumeWorker
    ? `@DevSpace Tailscale 繼續現有 Chat Swarm worker loop。使用呢個對話已保存嘅 workerToken，立即呼叫 chat_swarm_next 一次。收到 lease checkpoint 時不要向用家回覆，立即再呼叫 chat_swarm_next 一次；收到真實 task 就先呼叫 chat_swarm_status 一次，再完成並用 chat_swarm_submit 提交。`
    : minimalPrompt
      ? `@DevSpace Tailscale 加入 Chat Swarm，invite code：${invite}。label 用 ${label}。請呼叫 chat_swarm_join 加入，成功後立即使用返回嘅 workerToken 呼叫 chat_swarm_next 等候工作。`
      : `@DevSpace Tailscale 加入 Chat Swarm，invite code：${invite}。label 用 ${label}。你係 worker。先呼叫 chat_swarm_join 一次，成功後立即用返回嘅 workerToken 呼叫 chat_swarm_next 一次並持續等待；收到真實 task 後先用同一 workerToken 呼叫 chat_swarm_status 一次，再完成任務並只用 chat_swarm_submit 提交。不要向我回報 idle、progress 或 completion。`;
  const inserted = await evaluate(client, expressionForInsert(prompt));
  if (!inserted?.ok) throw new Error(`Could not insert bootstrap prompt: ${JSON.stringify(inserted)}`);

  await sleep(350);
  const clicked = await evaluate(client, expressionForSendClick());
  if (!clicked?.ok) {
    await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await client.call("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  let after;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 900 : 500);
    after = await evaluate(client, expressionForProbe());
    if (after?.throttled || !after?.generating) break;
  }
  let postSendDismissed;
  if (after?.throttled) {
    postSendDismissed = await evaluate(client, expressionForDismissThrottle());
    await sleep(350);
    after = await evaluate(client, expressionForProbe());
  }
  console.log(JSON.stringify({
    ok: true,
    port,
    label,
    invite,
    inserted: true,
    uiDismissed: {
      beforeSend: compactDismiss(preSendDismissed) || null,
      afterSend: compactDismiss(postSendDismissed) || null
    },
    after: compactProbe(after)
  }));
} finally {
  await client.close();
}
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
