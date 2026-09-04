# vNext Durable Object Storage Hot-Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unnecessary SQLite-backed Durable Object KV reads/writes from idle Chat Swarm polling without reducing worker wake responsiveness, then reduce cold-start SQL hydration cost without breaking historical task/artifact reads.

**Architecture:** Keep the existing 1.5s SSE responsiveness and singleton Durable Object routing. Cache Chat Swarm compat state once per Durable Object instance, persist only real durable state transitions on idle hot paths, and retain immediate persistence for dispatch/claim/submit/close mutations. For cold-start hydration, load only non-terminal tasks and lazy-load historical tasks/artifacts from durable SQL on demand.

**Tech Stack:** TypeScript, Cloudflare Durable Objects SQLite/KV APIs, Node assert test harness, GitHub Actions.

**Spec:** Existing production code and Cloudflare usage incident analysis in this conversation.

## Global Constraints

- Do not lower Chat Swarm wake responsiveness as the primary optimization.
- Do not deploy to production from this branch.
- Preserve task routing, targeted-worker continuity, browser wake, Worker Dock, restart recovery, and historical task/artifact reads.
- Follow TDD: failing regression test before each production change.
- Base branch is `feature/vnext-remote-gateway` at `a3d32811b7d814480e8fc19e8af56cf14281fb53`.

---

### Task 1: Chat Swarm idle storage I/O regression

**Files:**
- Modify: `vnext/tests/cloudflare/chat-swarm-browser-e2e.test.ts`
- Modify: `vnext/src/swarm/chat-swarm-compat.ts`

**Interfaces:**
- Consumes: `DurableChatSwarmCompat`, `CompatStorage.get/put`.
- Produces: one-per-instance cached compat state and a conditional-persist execution path for idle event/next loops.

- [ ] **Step 1: Write failing tests** that count Durable Object KV `get`/`put` calls and prove repeated parked browser/worker events and idle `next()` checks do not persist state on every poll after the initial state load.
- [ ] **Step 2: Run CI and verify RED** because current `mutate()` always calls `load()` and `save()`.
- [ ] **Step 3: Implement minimal state cache** in `DurableChatSwarmCompat` so `load()` reads storage once per instance and critical `mutate()` calls still persist immediately.
- [ ] **Step 4: Add conditional persistence for hot paths** keyed to durable swarm revision changes, so heartbeat-only last-seen updates remain in-memory while task offer/claim changes persist.
- [ ] **Step 5: Run full vNext CI and verify GREEN.**

### Task 2: Historical task/artifact lazy fallback

**Files:**
- Modify: `vnext/tests/cloudflare/workers-runtime.test.ts`
- Modify: `vnext/src/storage/task-store.ts`
- Modify: `vnext/src/storage/artifact-store.ts`
- Modify: `vnext/src/storage/storage-adapter.interface.ts` only if a new query interface is required
- Modify: `vnext/src/cloudflare/sqlite-storage-adapter.ts`
- Modify: `vnext/src/cloudflare/gateway-durable-object.ts`
- Modify: `vnext/src/mcp/handlers.ts`

**Interfaces:**
- Produces: async durable task lookup fallback and async durable task-artifact lookup fallback; active-only cold-start hydration query.

- [ ] **Step 1: Write failing cold-start tests** proving completed tasks and artifacts remain queryable after a new Durable Object instance even when terminal history is not pre-hydrated.
- [ ] **Step 2: Run CI and verify RED.**
- [ ] **Step 3: Add durable lookup fallbacks** that cache fetched records back into the in-memory stores.
- [ ] **Step 4: Add `listActiveTasks()`** using a SQL predicate that excludes terminal `succeeded`, `failed`, and `cancelled` rows and has an index aligned with active status/order access.
- [ ] **Step 5: Stop hydrating all artifacts** at constructor startup; use durable `id`/`taskId` lookups when needed.
- [ ] **Step 6: Add ordering indexes** required by active/admin/audit queries without changing endpoint semantics.
- [ ] **Step 7: Run full vNext CI and verify GREEN.**

### Task 3: Review and merge readiness

**Files:**
- No production changes unless verification exposes a regression.

- [ ] **Step 1: Review PR diff for accidental behavior changes.**
- [ ] **Step 2: Confirm GitHub Actions build, full tests, and Wrangler dry-run pass.**
- [ ] **Step 3: Leave production deployment to the local/Antigravity validation stage after merge approval.**
