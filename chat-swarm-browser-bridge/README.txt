Chat Swarm Wake Bridge (Chrome/Edge)

Load this repository's unpacked extension directory:
<devspace-ultra checkout>\chat-swarm-browser-bridge

Chrome: chrome://extensions -> Developer mode -> Load unpacked
Edge:   edge://extensions  -> Developer mode -> Load unpacked

Open the extension popup and enter your own DevSpace base URL (HTTPS for remote endpoints; http://127.0.0.1 or http://localhost is accepted for local development) plus the Chat Swarm invite code. The extension stores this URL locally in Chrome/Edge extension storage; no developer-specific endpoint is bundled.

Use dedicated ChatGPT WEB tabs for workers (https://chatgpt.com), not the desktop app.
Join each worker with chat_swarm_join_browser. The assistant will output a marker like [[CHAT_SWARM_BIND:...]]. The extension binds automatically, shows a small "Swarm worker-XX: parked" badge, and keeps only a lightweight browser-to-DevSpace event stream open.

When work is available the extension sends one wake message into that exact ChatGPT tab. The worker calls chat_swarm_claim (non-blocking), completes one task, submits with chat_swarm_submit_once (non-blocking), then ends the turn. Idle workers use zero ChatGPT model/tool requests.
