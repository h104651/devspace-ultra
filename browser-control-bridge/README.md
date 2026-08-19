# DevSpace Browser Control Bridge

Local Chrome/Chromium bridge for the DevSpace Ultra `browser_control_*` tools.

This extension is intentionally local-first. It only accepts a DevSpace endpoint on `localhost` / `127.0.0.1`, pairs with a one-time code, and stores the resulting private bridge token in the Chrome profile rather than in chat.

## Load locally

Normal branded Chrome 137+ no longer honors command-line `--load-extension` for unpacked extensions, so production/local-user setup uses Chrome's normal one-time **Load unpacked** UI. The automated live gate uses Chrome for Testing instead.

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `browser-control-bridge` directory.
5. Pin **DevSpace Browser Control Bridge** if you want quick access to tab sharing.

## Pair with DevSpace

1. In an MCP conversation connected to the local DevSpace Ultra server, call `browser_control_pair`.
2. Open the extension popup.
3. Keep the endpoint at `http://127.0.0.1:7676` unless your local DevSpace server uses a different localhost port.
4. Enter the one-time pair code.
5. Choose an access mode:
   - **Only tabs I explicitly share** (default): existing tabs are invisible to agents until you press **Share current tab**. Tabs opened by DevSpace are shared automatically.
   - **All normal browser tabs**: every controllable http(s) or about:blank tab in this Chrome profile is discoverable for claiming.
6. Pair once. The bridge reconnects from its local saved token after Chrome restarts.

## Claim model

DevSpace agents do not control a tab merely because the extension can see it. The agent must call `browser_control_claim` and receives an exclusive short-lived claim token. While that claim is active, another agent cannot claim the same tab. The lease renews when the agent performs browser-control calls and expires if abandoned.

While claimed, the page shows a compact non-interactive bottom-right **AGENT CLAIMED THIS TAB** control strip with the claim owner/current action, plus a Codex-like black agent pointer and click pulse. The indicator is removed on release/detach and never becomes part of normal page input handling.

When the agent finishes, it should call `browser_control_release`, which detaches the Chrome debugger from the tab. Closing a claimed managed tab also clears the claim.

## Normal tool flow

```text
browser_control_status
  -> browser_control_claim
  -> browser_control_inspect(kind="snapshot")
  -> browser_control_act / browser_control_navigate / browser_control_wait
  -> browser_control_inspect (fresh snapshot after page changes)
  -> browser_control_release
```

Snapshots expose compact semantic refs such as `e1`, `e2`, and `e3` derived from Chrome's accessibility tree. Actions resolve those refs to real DOM nodes through CDP rather than guessing pixel positions. Screenshots and coordinate actions remain available as a fallback. Download diagnostics come from `Page.download*` events on the claimed tab; the extension does not request global Chrome download-history permission.

## Developer mode

The popup has an explicit **Developer mode** switch. When enabled, `browser_control_cdp` can call Chrome DevTools Protocol methods supported by the Chrome extension `debugger` API, with DevSpace safety blocks for browser-wide cookie/cache clearing and page crash methods.

Keep Developer mode off for ordinary web tasks. Prefer the higher-level snapshot/action tools because their surface is easier to audit and less error-prone.

## Security properties

- The endpoint is restricted to local loopback addresses by the extension.
- Pair codes are one-time and expire.
- The server persists only hashes of bridge and claim tokens.
- Existing tabs are opt-in by default.
- Claims provide per-tab multi-agent exclusion.
- Password values are masked from semantic snapshots and programmatic password-field filling is blocked. Enter credentials directly in Chrome and then let the agent continue.
- No high-level cookie/session export tool is exposed; direct CDP cookie read/write methods are blocked even in Developer mode.
- Web content remains untrusted; the bridge does not convert website text into trusted instructions.

## Current scope

The local gate targets Google Chrome / Chromium MV3. The implementation uses `chrome.debugger`, `chrome.tabs`, `chrome.downloads`, and the Chrome DevTools Protocol. Other Chromium browsers may be compatible, but they should be treated as unverified until separately tested.

### Automated live gate

For repeatable destructive testing, install Chrome for Testing once if it is not already cached:

```bash
npx --yes @puppeteer/browsers@latest install chrome@stable --path "<your-temp>/devspace-browser-control-cft"
npm run verify:browser-control:live
```

The gate uses a temporary Chrome profile, never the user's normal Chrome profile.

This bridge ships with DevSpace Ultra 0.2.0 as an unpacked local Chrome extension. It is not a Chrome Web Store listing; install it with Chrome's **Load unpacked** flow described above.
