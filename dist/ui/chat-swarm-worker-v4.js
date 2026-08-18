const root = document.getElementById("worker-dock");
const statusEl = document.getElementById("status");
const workerEl = document.getElementById("worker");
const streamUrl = root?.dataset?.streamUrl;

let started = false;
let stopped = false;
let lastWakeTaskId = null;
let lastWakeAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setStatus = (text) => {
  if (statusEl) statusEl.textContent = String(text);
};

function normalizeToolOutput(value) {
  if (!value || typeof value !== "object") return null;
  if (value.workerToken) return value;
  if (value.structuredContent?.workerToken) return value.structuredContent;
  return null;
}

async function wakeWorker(event) {
  const now = Date.now();
  if (event.taskId === lastWakeTaskId && now - lastWakeAt < 45000) return;
  lastWakeTaskId = event.taskId;
  lastWakeAt = now;
  const openai = window.openai;
  if (typeof openai?.sendFollowUpMessage !== "function") {
    setStatus("wake API unavailable");
    return;
  }
  setStatus("task ready - waking");
  await openai.sendFollowUpMessage({
    prompt: "[CHAT_SWARM_DOCK_WAKE] Work is ready for this existing ChatGPT Classic worker conversation. Use the workerToken already stored in this conversation. Call chat_swarm_claim exactly once. Complete exactly one claimed task fully. Submit the complete result only through chat_swarm_submit_once. Do not report the task result, progress, or completion to the user. End this turn immediately after submit; Worker Dock will remain parked for later work.",
    scrollToBottom: false,
  });
  setStatus("task dispatched to ChatGPT");
}

async function consumeStream(workerToken) {
  if (!streamUrl) throw new Error("missing stream URL");
  const response = await fetch(streamUrl, {
    method: "GET",
    headers: { "X-Chat-Swarm-Worker-Token": workerToken },
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    throw new Error(`worker stream HTTP ${response.status}`);
  }
  setStatus("parked");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!stopped) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("worker stream ended");
    buffer += decoder.decode(chunk.value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      let event;
      try {
        event = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "task_available") await wakeWorker(event);
      if (event.type === "closed") {
        stopped = true;
        setStatus("swarm closed");
        return;
      }
      if (event.type === "parked") setStatus("parked");
    }
  }
}

async function startFromToolOutput(value) {
  const data = normalizeToolOutput(value);
  if (started || !data?.workerToken) return;
  started = true;
  if (workerEl) workerEl.textContent = `Worker Dock - ${data.workerId || "worker"}`;
  let backoff = 1000;
  while (!stopped) {
    try {
      await consumeStream(data.workerToken);
      backoff = 1000;
    } catch (error) {
      if (stopped) break;
      setStatus(`reconnecting in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

window.addEventListener(
  "message",
  (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      void startFromToolOutput(message.params?.structuredContent);
    }
  },
  { passive: true },
);

window.addEventListener(
  "openai:set_globals",
  () => {
    void startFromToolOutput(window.openai?.toolOutput);
  },
  { passive: true },
);

window.addEventListener("error", (event) => {
  setStatus(`error: ${event.message || "runtime"}`);
});
window.addEventListener("unhandledrejection", (event) => {
  setStatus(`error: ${String(event.reason?.message || event.reason || "promise")}`);
});

void startFromToolOutput(window.openai?.toolOutput);
setTimeout(() => {
  if (!started) setStatus("waiting for join result");
}, 500);
