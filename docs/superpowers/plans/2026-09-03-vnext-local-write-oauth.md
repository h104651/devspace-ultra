# vNext Local Write OAuth Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `local_write_file`, `local_patch_file`, and `local_create_directory` for the ChatGPT OAuth connector while preserving explicit scope-based authorization and keeping raw shell/admin privileges excluded.

**Architecture:** The local agent and capability router already support `local:write`; the current block is the public OAuth allowlist, which intentionally rejects that scope. Add `local:write` to the connector-approved scope set and update OAuth regression tests so write authorization is explicit, visible on the consent page, and preserved across refresh tokens. Do not add `local:exec`, `raw_shell:run`, or admin scopes in this change.

**Tech Stack:** TypeScript OAuth manager, scope checker, Node assert tests, GitHub Actions.

**Spec:** User requires DevSpace Ultra to edit authorized local project files; repository already exposes `local_write_file`, `local_patch_file`, and `local_create_directory` and maps them to `local:write`.

## Global Constraints

- Keep `admin`, `admin:*`, `raw_shell:run`, and unrelated privileged scopes forbidden to public ChatGPT OAuth clients.
- Authorization remains project/path guarded by the local agent; this change only makes the existing `local:write` scope grantable.
- Existing tokens without `local:write` must not magically gain it; reauthorization is required to obtain the new scope.
- Follow TDD: failing OAuth tests before production code.

---

### Task 1: Prove the OAuth scope regression

**Files:**
- Modify: `vnext/tests/oauth/oauth.test.ts`

- [ ] **Step 1: Change expected connector capability** so metadata, authorization-code issuance, token exchange, refresh, and consent rendering require `local:write` while still rejecting admin/raw-shell escalation.
- [ ] **Step 2: Run CI and verify RED** because `CHATGPT_LEAST_PRIVILEGE_SCOPES` currently omits `local:write` and `sanitizeScopes()` rejects it.

### Task 2: Restore authorized local writes

**Files:**
- Modify: `vnext/src/oauth/oauth-manager.ts`

- [ ] **Step 1: Add `local:write`** to `CHATGPT_LEAST_PRIVILEGE_SCOPES` without adding `local:exec` or `raw_shell:run`.
- [ ] **Step 2: Run OAuth and full vNext CI and verify GREEN.**
- [ ] **Step 3: Document operational consequence in PR:** existing ChatGPT connector authorization must be refreshed/re-authorized to receive the new scope.

### Task 3: Security review

**Files:**
- No additional production changes unless verification requires them.

- [ ] **Step 1: Confirm `ScopeChecker` still maps write/patch/create capabilities to `local:write`.**
- [ ] **Step 2: Confirm local agent executable capabilities already include write/patch/create.**
- [ ] **Step 3: Confirm public OAuth still rejects admin and raw shell.**
