# Contributing to DevSpace Ultra

Thanks for helping improve DevSpace Ultra.

## Before opening a PR

1. Reproduce the issue on the current `main` branch.
2. Keep changes scoped and preserve upstream DevSpace behavior unless the change intentionally extends it.
3. Run:

```bash
npm install --ignore-scripts
npm run verify:ultra
```

4. On Windows, syntax-check the PowerShell runtime scripts and exercise the affected runtime flow when possible.
5. Do not include ChatGPT cookies, worker tokens, orchestrator tokens, local profile backups, private paths, or credentials in fixtures/logs.

## Architecture rules

- The **Chat Swarm backend is the task-routing/control plane**.
- CDP/UI automation is lifecycle/bootstrap/recovery only; normal tasks must not be typed into worker UI.
- Scaling down must never interrupt a busy worker just to hit a requested number immediately.
- Preserve exact worker conversation continuity where possible.
- Keep Runtime-05 reserved by default unless a caller explicitly changes the reserved set.
- Platform-specific runtime automation must feature-detect and fail gracefully. Base DevSpace and backend Chat Swarm should stay portable.
- Update logic must be canary-first and rollback-capable.

## Tests

The core regression lives in `dist/chat-swarm.test.js` and covers multi-worker routing, persistence, repark, idempotency, recycle, and resize invariants.

Windows runtime changes should additionally validate as relevant:

- isolated runtime registration;
- login/profile persistence;
- CDP startup and minimized control;
- project-scoped worker creation;
- same-conversation recovery;
- elastic expansion and shrink;
- update canary/rollback behavior.

## Licensing and upstream attribution

DevSpace Ultra is MIT licensed and based on the MIT-licensed upstream DevSpace project. Do not remove upstream attribution from `LICENSE`, `NOTICE`, or documentation.

## Commit / PR style

Prefer small commits with an observable gate in the PR description. Explain what was tested and what remains platform-specific or unverified.
