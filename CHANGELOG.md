# Changelog

## 0.3.0 — 2026-08-20

### Added

- Shared **Unified Agent Capability Runtime** instantiated once per DevSpace backend and exposed identically to orchestrator and worker MCP sessions.
- User-level plugin store at `~/.devspace/plugins` with managed packages, metadata-only registry, enable/disable, Git update, and safe managed uninstall lifecycle.
- Twelve progressive-disclosure `capability_*` agent tools for compact catalog/search, inspection, install, trust/enable, disable, update, uninstall, refresh, resource reading, stateful MCP instance claims, and tool invocation.
- Multi-format discovery for Agent Skills (`SKILL.md`), agent instruction files, DevSpace universal manifests, Claude-style and Codex-style plugin roots/components, MCP client configs, nested `*.mcp.json` profiles, and official MCP Registry `server.json` metadata/remotes.
- Shared MCP client proxy supporting stdio, Streamable HTTP, and legacy SSE transports, with bounded connect/call timeouts, connection deduplication across agents, progressive discovery/use of MCP tools/prompts/resources, and isolated exclusive stateful instances for project-bound MCPs such as Blender.
- Explicit command-tool adapter format using shell-free process execution, JSON stdin, bounded output, plugin-confined cwd, and execution timeouts.
- GitHub/Git/local-directory installation without package install hooks; newly downloaded executable code remains disabled/untrusted until explicitly trusted.
- Secret-safe MCP configuration using environment-variable names rather than persisted values, including official MCP Registry URL variables and header descriptors; remote transports reject non-HTTP(S) URLs.
- Plugin skills join normal `open_workspace` skill discovery only after the plugin is enabled and trusted; resource/cwd resolution blocks lexical and symlink escapes from the plugin root.
- Nested/monorepo plugin discovery so one Git repository can contain multiple plugin roots and reusable MCP profiles.
- Stateful MCP `instanceId` leases with private in-memory instance tokens, ephemeral per-instance environment overrides, isolated MCP processes, same-instance exclusion, and serialized same-template cold-start to avoid package-manager/cache races.
- Windows stdio compatibility preserves the minimal `COMSPEC`/`PATHEXT`/`WINDIR` process context needed by package managers such as `uv` without inheriting the full parent environment.

### Verified for release

- Deterministic fixture exercises install-without-execution, trust gate, two independent MCP-session catalogs, compact search, Agent Skill discovery, bounded/symlink-safe instruction reads, shared MCP connection dedupe/refresh invalidation, real stdio MCP tools/prompts/resources, command tools, official Registry metadata/remotes, secret non-persistence, disable/re-enable, and uninstall.
- Real GitHub install gate clones the current `oceanbase/powermem` repository into an isolated temporary plugin store, detects its nested Claude plugin/Agent Skills/instructions/MCP profile, performs no plugin execution, and removes the package cleanly afterward.
- Codex plugin compatibility gate scans every local `.codex-plugin/plugin.json`, fails on unknown manifest fields/missing declared paths, and currently passes 71/71 manifests across bundled, curated, remote-curated, personal, staging, archived, and source-tree packages. Skills/MCP are directly reusable; platform App connector IDs and Codex lifecycle hooks are preserved as explicit host dependencies rather than silently emulated.
- Real dual-Blender gate uses the user's installed Blender 5.1 extension plus Blender Lab MCP v1.0.0 through the Capability Runtime: two isolated Blender processes/projects expose the same complete 26-tool catalog, accept simultaneous project-specific calls, and pass cross-project marker isolation plus high-level object/datablock summary checks.

## 0.2.0 — 2026-08-19

### Added

- DevSpace Browser Control Bridge for Google Chrome / Chromium with local one-time pairing.
- Exclusive per-tab claim leases so multiple agents can safely share one browser without racing the same tab.
- Visible claimed-tab UI: compact bottom-right **AGENT CLAIMED THIS TAB** control strip, claim-owner/current-action labels, Codex-like black agent pointer, and click pulse.
- Claim an existing user-approved Chrome tab or open/claim a new managed work tab on demand.
- Semantic accessibility snapshots with ephemeral element refs for click/fill/type/press/select/check/focus/hover/scroll/drag actions.
- Screenshot, console, network, and download inspection surfaces.
- Explicit Developer mode for supported Chrome DevTools Protocol commands with destructive browser-wide clearing/crash methods blocked.
- Automatic claim revocation on unshare/disconnect, managed-tab cleanup on attach failure, debugger detach on release/expiry, and Chrome restart/reconnect recovery.
- Programmatic password-field fill blocking; credentials stay in the user-controlled browser UI.
- Browser-control state persists token hashes/claims but keeps live tab URLs/titles memory-only.
- Deterministic Browser Control regression suite and isolated Chrome-for-Testing live extension gate.

### Verified for release

- One-time pair and bridge reconnect across Chrome restart.
- New-tab claim and exclusive competing-claim rejection.
- Visible claim banner + black pointer, semantic snapshot, focus/fill/type/key press, checkbox/select, hover/double-click, drag/scroll, submit/page-state transition, screenshot, console/network/download capture, navigation, and wait conditions.
- Release/expiry detach, unshare revocation, re-pair claim invalidation, and failed managed-tab attach cleanup.
- Three independent MCP sessions (orchestrator + two worker-style sessions) can hold simultaneous exclusive claims on three different Chrome tabs.
- Existing Chat Swarm regression remains green under `npm run verify:ultra`.

## 0.1.0 — 2026-08-18

Initial DevSpace Ultra public distribution, based on DevSpace 1.0.5.

### Added

- Chat Swarm coordinator and worker lifecycle for independent ChatGPT Classic conversations.
- Targeted and first-available routing, idempotent task keys, submit/repark, cancellation, persistence, and recovery.
- Long parked worker leases with checkpoint renewal.
- Windows isolated ChatGPT Classic runtime cloning by package identity.
- Controller actions for setup, start, ensure, status, minimize, recovery, capture, auto-join, stop, and elastic scale.
- Automatic worker creation inside a configured `sub-agents` ChatGPT Project.
- Exact project/top-level conversation URL capture and recovery.
- UI obstruction dismissal and interrupted-connection detection.
- Elastic runtime expansion/shrink with operator-configurable reserved runtime numbers; the public default reserves none.
- Safe live Swarm resize with tail-only shrink invariants.
- ChatGPT Classic version drift detection and canary/rolling-update/rollback tooling.
- `devspace-ultra` CLI alias while retaining `devspace` compatibility.
- Cross-platform installation scripts and explicit platform capability matrix.

### Verified on the development machine

- 4-worker zero-touch join and parallel dispatch.
- Same-worker context continuity.
- DevSpace restart persistence.
- Runtime kill/relaunch recovery.
- Cold close/reopen of all production runtimes.
- Multi-checkpoint long-idle soak followed by 4/4 dispatch.
- Elastic provisioning of Runtime-06 and Runtime-07, successful worker joins/tasks, and scale-down.
- Chat Swarm regression covering 9-worker waves, sparse wake-up, retry idempotency, persistence, recycle, and resize safety.

### Platform notes

The core DevSpace/Chat Swarm layer is portable across supported Node platforms. Autonomous ChatGPT Classic desktop package cloning/recovery and the package update manager are Windows-specific in 0.1.0.
