# DevSpace Ultra Browser Control — Architecture & Local Verification

Status: **released in DevSpace Ultra 0.2.0** (2026-08-19). The release gate includes deterministic regression, isolated Chrome-for-Testing live verification, multi-session claim isolation, package inspection, and secret/private-state scanning.

## Goal

Give any DevSpace-connected agent a first-class browser/computer-use surface that can:

- discover user-approved existing Chrome tabs;
- exclusively **claim** one tab so multiple agents do not race each other;
- open and claim a new work tab on demand;
- inspect pages semantically and visually;
- click, type, fill, press keys, scroll, drag, select, check, navigate, wait, and take screenshots;
- inspect browser console, network, and claimed-tab download events;
- expose a controlled CDP developer escape hatch when the user explicitly enables Developer mode;
- reuse the user's real signed-in Chrome profile without exporting cookies or passwords to chat;
- fail safe when a claim is abandoned, a tab disappears, or the extension disconnects.

The browser-control layer is independent from Chat Swarm. A main agent or any subagent can use it, subject to exclusive tab claims.

## Research basis

The design intentionally follows the useful boundaries exposed by current browser-use systems rather than implementing only screenshot-and-pixel automation:

- OpenAI's Codex/ChatGPT browser guidance distinguishes built-in browser state from using the Chrome extension when an agent needs the user's existing Chrome profile, signed-in sessions, open tabs, or browser extensions.
- OpenAI's Browser Developer mode exposes controlled Chrome DevTools Protocol access for DOM/page state, console, network, and performance debugging, while keeping broad CDP access explicitly gated.
- Chrome's official `chrome.debugger` extension API is a supported transport for a substantial CDP subset, including Accessibility, DOM, Input, Network, Page, Runtime, Target, and related developer domains.
- Chrome's accessibility tree and DOM backend node IDs provide a stronger semantic targeting layer than raw screenshot coordinates alone.

Those observations lead to a two-tier architecture: safe higher-level browser tools for normal use, plus explicit Developer mode for advanced CDP debugging.

## Architecture

```text
Agent / Orchestrator / Subagent
        |
        | MCP browser_control_*
        v
DevSpace BrowserControlCoordinator
  - pair-code issuer
  - bridge registry
  - tab registry
  - exclusive claim/lease manager
  - semantic ref registry
  - command queue/result router
        |
        | local HTTP long-poll bridge protocol
        v
Chrome MV3 Browser Control Bridge
  - selected/all tab sharing policy
  - chrome.debugger attach/detach
  - CDP Accessibility / DOM / Input / Page / Runtime / Network / Log
  - screenshot capture
  - console/network/download ring buffers
        |
        v
Existing user Chrome tab OR newly created managed tab
```

### Why an extension instead of launching a separate Playwright browser

Launching Playwright is excellent for isolated automation, but it does not automatically give an agent the user's already-signed-in Chrome profile, existing tabs, or installed extensions. This feature specifically targets that missing capability. It can coexist with Playwright; it is not a replacement for isolated browser test automation.

## Pairing and transport

Pairing is intentionally separate from MCP OAuth:

1. Agent calls `browser_control_pair`.
2. DevSpace generates a random one-time pair code and keeps only a hash in memory for a short TTL.
3. User enters the code in the locally loaded Chrome extension.
4. Extension POSTs the code plus its instance key to the local DevSpace endpoint.
5. DevSpace returns a high-entropy bridge token.
6. The extension stores the bridge token in `chrome.storage.local`; DevSpace persists only its hash.
7. The extension long-polls the local command endpoint and sends command results back with that token.

The extension rejects non-loopback endpoints, so the control transport remains local even if the main DevSpace MCP endpoint is also exposed through another authenticated transport.

## Tab sharing and claims

Seeing a tab and controlling a tab are separate states.

### Access modes

**Selected tabs (default)**

- User explicitly shares existing tabs from the extension popup.
- Tabs opened by DevSpace are automatically marked managed/shared.
- Other existing tabs are absent from `browser_control_status`.

**All normal tabs**

- All normal controllable tabs in that Chrome profile are discoverable.
- This requires an explicit user preference change in the extension.

### Exclusive claims

`browser_control_claim` creates an exclusive lease for one tab and returns a private `claimToken`.

Properties:

- another agent cannot claim the same tab while the lease is valid;
- the claim renews on normal browser-control operations;
- abandoned claims expire automatically;
- release/expiry detaches the `chrome.debugger` session;
- claims are persisted only as token hashes;
- live tab URL/title metadata is kept memory-only and re-synced by the extension after restart rather than written to disk;
- semantic element refs are stored in memory and disappear when the server restarts;
- unsharing a tab, disconnecting/re-pairing the bridge, or removing a tab revokes matching claims and triggers debugger detach.

This is the key multi-agent difference from a conventional single-session browser-control tool: the browser becomes a schedulable shared resource rather than a global mutable singleton.

## Semantic inspection

`browser_control_inspect(kind="snapshot")` requests `Accessibility.getFullAXTree` through `chrome.debugger`.

The extension returns a compact set of interactive/informational nodes including `backendDOMNodeId`. DevSpace assigns ephemeral refs:

```text
[e1] heading "Checkout"
[e2] textbox "Email"
[e3] button "Continue"
```

When an action refers to `e3`, the extension resolves the backend DOM node. Semantic left-click/fill/select/check operations act on that real DOM element; hover/drag/coordinate fallbacks can scroll it into view, obtain its box model, and use CDP input events at the rendered position.

This makes ordinary actions:

- more stable than visual coordinates;
- inspectable by the model;
- compatible with screenshot fallback;
- naturally invalidated after navigation or major page changes.

Agents are instructed to take a fresh snapshot after navigation and substantial DOM changes.

## High-level action surface

### `browser_control_status`
Read-only bridge/tab/claim discovery.

### `browser_control_claim`
Claim an existing shared tab or open a new tab (`openUrl`) and claim it.

### `browser_control_inspect`

- `snapshot`: semantic accessibility snapshot + refs;
- `screenshot`: viewport/full-page screenshot;
- `console`: recent console/log events;
- `network`: recent request/response/failure events;
- `downloads`: recent `Page.download*` events scoped to the claimed/attached tab (not a global Chrome-profile download history).

### `browser_control_act`

- click / doubleClick;
- fill / type;
- press;
- hover;
- scroll;
- select;
- check;
- focus;
- drag.

### `browser_control_navigate`

goto / back / forward / reload / stop / activate / close.

### `browser_control_wait`

load / URL substring / visible text / CSS selector / bounded delay.

### `browser_control_release`
Releases the exclusive lease and detaches the debugger.

### `browser_control_cdp`
Explicit Developer-mode escape hatch. DevSpace allowlists Chrome-extension-supported CDP domains and blocks browser-wide cookie/cache clearing and page-crash commands.

## Credential boundary

The bridge does **not** provide a cookie exporter or password extraction feature.

Programmatic fill on `<input type="password">` is refused in the extension. If a task reaches a login page, the user can type credentials directly into their normal Chrome tab. The agent can then continue using the authenticated page state without the credential ever entering chat or DevSpace browser-control commands.

This matches the product goal: reuse a signed-in browser, not turn the browser into a credential exfiltration mechanism.

## Prompt-injection boundary

A controlled website is an untrusted external environment. Page text must never be treated as trusted DevSpace/system instructions merely because it appears in a semantic snapshot or screenshot.

The server instruction explicitly tells agents to treat website content as untrusted. Browser-control output is observation, not authority.

## Failure handling

- **Extension offline:** claim operations fail rather than silently switching to a different browser.
- **Tab disappears / is unshared:** the bridge sync removes it; matching claims are revoked and debugger detach is scheduled.
- **Claim expires:** claim becomes invalid and debugger detach is attempted.
- **Attach fails:** a claim is not created; a newly opened managed tab is closed again so failed work does not leave browser clutter.
- **Stale semantic ref:** action fails and instructs the agent to take a new snapshot.
- **Command timeout:** pending command is rejected; the agent gets an explicit MCP error.
- **Server restart:** paired bridge/hashed claims reload, but in-memory refs and command waiters reset. The extension reconnects and syncs tabs again.

## Verification gates

### Deterministic coordinator gate

`dist/browser-control.test.js` covers:

- one-time pairing;
- online bridge/tab sync;
- exclusive existing-tab claim;
- semantic snapshot and ephemeral refs;
- action dispatch;
- screenshot result path;
- new managed tab creation/claim;
- claim release/detach;
- claim expiry cleanup;
- safe attach failure and failed managed-tab close cleanup;
- unshare/re-pair/tab-instance/browser-session claim revocation;
- DevSpace server restart with same-browser-session claim continuity;
- Developer-mode guard before CDP command queueing and CDP allow/block policy, including direct cookie read/write methods;
- raw pair/bridge/claim secrets absent from persisted state and live tab URL/title data kept memory-only.

### Existing DevSpace regression gate

`npm run verify:ultra` must continue to pass the existing Chat Swarm regression suite plus Browser Control syntax/tests.

### Live Chrome gate — PASS (2026-08-19)

The automated end-to-end gate now passes against an isolated **Chrome for Testing** profile with the real unpacked MV3 extension. Chrome for Testing is deliberately used for automation because normal branded Chrome removed command-line `--load-extension` support starting in Chrome 137; real-user Chrome installation therefore uses the one-time manual **Load unpacked** flow from `chrome://extensions`.

`npm run verify:browser-control:live` proves:

1. untrusted normal web origin rejected from the local bridge transport — **PASS**;
2. one-time extension pairing with local DevSpace — **PASS**;
3. bridge online/sync — **PASS**;
4. create and exclusively claim a real Chrome work tab — **PASS**;
5. semantic Accessibility snapshot exposes expected controls — **PASS**;
6. fill and click by semantic ref — **PASS**;
7. password values masked from semantic snapshots and password-field programmatic fill blocked — **PASS**;
8. expected page-state transition — **PASS**;
9. screenshot capture — **PASS**;
10. console capture — **PASS**;
11. network capture — **PASS**;
12. claimed-tab download capture — **PASS**;
13. concurrent second claim rejection — **PASS**;
14. claim release + debugger detach — **PASS**;
15. Chrome stop/restart with the same isolated profile + extension reconnect — **PASS**;
16. stale pre-restart claim revocation after browser-session rotation — **PASS**.

Latest live result:

```json
{
  "ok": true,
  "pairing": "PASS",
  "crossOriginWebPageBlocked": "PASS",
  "newTabClaim": "PASS",
  "semanticSnapshot": "PASS",
  "semanticFillClick": "PASS",
  "passwordSnapshotMasked": "PASS",
  "passwordFillBlocked": "PASS",
  "pageState": "PASS",
  "screenshot": "PASS",
  "consoleCapture": "PASS",
  "networkCapture": "PASS",
  "downloadCapture": "PASS",
  "exclusiveClaim": "PASS",
  "releaseDetach": "PASS",
  "chromeRestartReconnect": "PASS",
  "restartRevokesStaleClaim": "PASS",
  "browserSessionRotated": "PASS"
}
```

The gate also found and closed two real compatibility problems during implementation:

- recent Chrome builds rejected the original debugger protocol version requested by the extension, so attach now negotiates `1.3 -> 1.2 -> 0.1` instead of assuming one version;
- CDP mouse input against a background tab did not reliably fire the test page's click handler, so **semantic left-click** now resolves the real DOM node and invokes its click path, while coordinate/right/middle input remains available as a visual/pixel fallback.

The live gate does **not** use the developer's normal Chrome profile, cookies, or signed-in sessions. Production use can reuse a user's normal signed-in Chrome profile only after that user explicitly loads/pairs the extension.

## Release policy for this development phase

The user explicitly requested local completion first. Therefore:

- do not push these changes to GitHub yet;
- do not tag/release a new DevSpace Ultra version yet;
- do not claim Chrome Web Store availability;
- finish observable local gates before preparing a public release.
