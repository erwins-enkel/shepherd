# GitHub Warm Restart Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session. Steps use checkbox syntax for tracking.

**Goal:** Preserve GitHub read caches across restarts and avoid redundant startup scans.

**Architecture:** One shared typed cache rehydrates versioned SQLite rows. Fingerprint content
keys validate reads, and shared invalidation revisions guard concurrent writes. The fingerprint
controls readiness for broad background work.

**Tech Stack:** Existing TypeScript, Bun tests and bun:sqlite; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-github-warm-restart-design.md`

## Global Constraints

- Persisted maximum age before background refresh: 24 hours.
- Background GraphQL reserve: 1,000 points.
- Preserve current fallback/error behavior when persistence is not injected.
- One PR; work only in this worktree; verify root lint and tests before committing.

## Review Focus

- Partial fingerprint failure must retain rehydrated coverage for the missing chunk.
- A late pre-write fetch must never recreate an invalidated disk row.
- Counts from a second forge instance must reflect shared invalidation.
- Map/Set data and complete/partial epic status must survive restart safely.
- A successful fingerprint that leaves the budget below reserve must not release scans.

### Task 1: Persist and rehydrate read data

**Files:** `src/github-read-cache.ts`, `src/store.ts`, `src/repo-fingerprint.ts`,
`src/forge/{github,repo-freshness,index,resolve}.ts`, `src/{backlog,open-pr-snapshot}.ts`,
and corresponding root tests.

**Interfaces:** `GithubReadCache(store, { now?, canRefresh? })`; typed
`get(kind, slug, entryKey?)`, `put(kind, slug, contentKey, value, entryKey?)`,
`invalidate(slug, kinds)`, `revision(slug)` and `contentKey(kind, slug)`.
Store methods list/put/delete versioned rows with JSON payload, content key and timestamp.
`RepoFingerprintDeps.cache?` rehydrates fingerprints; `issuesKey(slug)` supplies content freshness.

- [x] Write restart, backoff/reset, changed-key, serialization, age and write-race tests.
- [x] Run focused tests; expect missing persistence/rehydration behavior to fail.
- [x] Implement the shared cache, SQLite methods, fingerprint rehydration and consumer integration.
- [x] Run focused tests; expect all restart and existing forge/cache tests to pass.

### Task 2: Gate startup and deliver

**Files:** `src/index.ts`, `src/up-next.ts`, `src/pr-poller.ts`, `src/branch-pruner.ts`, root boot/poller tests.

**Interfaces:** `RepoFingerprintService.backgroundReady()` becomes true only after successful
observation and while budget permits. Inject this gate into background startup and daily cache
refresh. Stable session polling reuses covered open-PR data; transient polling stays fresh.

- [x] Write tests for delayed boot work, budget reserve and transient PR polling.
- [x] Run focused tests; expect premature background work to fail.
- [x] Wire the shared cache before forge construction and gate broad scans on fingerprint readiness.
- [x] Run root lint and tests; expect success. Review changes and fix defects.
- [ ] Commit the complete verified change, obtain one independent branch review,
      fetch/rebase onto `origin/main`, rerun necessary verification and open one PR closing #2826.
