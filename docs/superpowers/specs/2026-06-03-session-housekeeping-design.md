# Session Housekeeping — Database Retention for Older Sessions

**Date:** 2026-06-03
**Status:** Design approved, pending implementation plan

## Problem

Archiving a session stops its agent and removes its worktree, but the row stays in
the SQLite DB (`~/.shepherd/shepherd.db`) forever. Archived `sessions` rows — and
their dependent `reviews` rows — accumulate without bound. There is precedent for
housekeeping (`pruneSignals` deletes signals older than 60 days, daily) but nothing
prunes archived sessions.

## Policy

Delete an **archived** session when **either** condition holds (union / whichever
hits first):

- **Age:** `archivedAt` older than **30 days**, OR
- **Count:** the session is **not** among the **newest 250 archived sessions** (global,
  across all repos).

Decisions made during brainstorming:

- **Scope of count:** global, not per-repo. The goal is bounding total DB size; the
  30-day age rule already protects genuinely-recent sessions regardless of repo.
- **Archived only.** Non-archived rows (`running`/`idle`/`blocked`/`done`) are never
  touched, even if stale — sweeping live-status rows risks deleting a session whose
  worktree still exists, and overlaps reconcile/poller responsibilities.
- **Cascade `reviews`.** A `reviews` row is PK'd by `sessionId`, so a deleted session
  would orphan it forever — delete it alongside the session.
- **Leave `signals` alone.** They have their own independent 60-day prune and serve a
  different purpose (learnings-distiller input), not session history.

## Approach

**Collect-victims-then-cascade in a transaction** (chosen over a single combined
`DELETE` with subqueries): compute the victim id set once, delete their `reviews`,
then delete the `sessions`, all wrapped in a `db.transaction`. The cascade is explicit
and atomic, returns an accurate count, and can't half-delete (session gone, review
orphaned) if interrupted. Mirrors the precision of the existing `archiveMany`
transactional teardown.

## Design

### 1. Storage layer — `src/store.ts`

New method, modeled on `pruneSignals`:

```ts
/** Delete archived sessions beyond the retention window (age OR global count),
 *  cascading their reviews. Returns the number of sessions removed. */
pruneArchivedSessions(opts: { maxAgeMs: number; keepNewest: number }): number
```

- **Victim selection** (inside a `this.db.transaction`): archived rows where
  `archivedAt < (now − maxAgeMs)` **OR** not among the `keepNewest` most-recent by
  `archivedAt`.
- **Legacy guard:** order and compare using `COALESCE(archivedAt, updatedAt, createdAt)`
  so legacy archived rows with a null `archivedAt` still sort and expire correctly
  instead of being treated as infinitely old/new.
- Delete dependent `reviews` (`WHERE sessionId IN (victims)`) first, then the
  `sessions`. `signals` untouched.
- Returns the count of sessions removed.

### 2. Constants & kill-switch — `src/index.ts`

Named constants (single tuning point; per the YAGNI-on-per-threshold-UI decision):

```ts
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_RETENTION_KEEP = 250;                    // newest archived to keep
```

Global kill-switch setting in the `settings` table, key `sessionHousekeepingEnabled`,
defaulting **ON** (a safe sweep with a kill switch, per house rules). Loaded into the
`config` runtime object at startup exactly like `remoteControlAtStartup` (persisted as
`"1"`/`"0"`).

### 3. Background sweep — `src/index.ts`

Fold into the existing daily sweep rather than add a second timer (runs once ~10s after
boot, then every 24h):

```ts
const runDistillSweep = () => {
  if (config.sessionHousekeepingEnabled)
    store.pruneArchivedSessions({
      maxAgeMs: SESSION_RETENTION_MS,
      keepNewest: SESSION_RETENTION_KEEP,
    });
  store.pruneSignals(Date.now() - 60 * 24 * 60 * 60 * 1000);
  for (const repo of listRepos(config.repoRoot)) distiller.consider(repo.path);
};
```

Rename `runDistillSweep` → `runDailySweep` since it now does more than distill (update
the related comment too — stale names/comments get flagged in review).

### 4. API — `src/server.ts`

Extend the existing `/api/settings` handler (the `remoteControlAtStartup` pattern):

- `GET` response gains:
  - `sessionHousekeepingEnabled: boolean`
  - `sessionRetentionDays: 30` and `sessionRetentionKeep: 250` — **display only**, so
    the UI copy shows the real numbers instead of hardcoding a mirror of the server
    constants (per "never hardcode a UI constant to mirror a server constant").
- `PUT` gains a standalone boolean patch → `putSessionHousekeeping(value, deps)` that
  validates boolean, updates `config`, persists via `setSetting`.

### 5. UI — `ui/src/lib/components/Settings.svelte`

A toggle row alongside the Remote Control toggle (reuse its markup/pattern), wired to
the GET/PUT. Label + helper text explain it auto-deletes archived sessions older than
N days or beyond the newest M, with N/M interpolated from the GET payload.

### 6. i18n (required)

Add matching keys to **both** `ui/messages/en.json` and `ui/messages/de.json`:

- `settings_housekeeping_label`
- `settings_housekeeping_hint` — uses `{days}` / `{count}` interpolation, fed from the
  settings GET payload so the copy can't silently desync from the server constants.

The catalog-parity gate (`cd ui && bun run check:i18n`) enforces EN/DE key parity.

## Testing

Root tests (`bun test ./test`), following existing store-test patterns:

- `pruneArchivedSessions` unit tests (temp/in-memory DB):
  - Archived row older than `maxAgeMs` → deleted; younger one within `keepNewest` → kept.
  - With > `keepNewest` archived rows all younger than `maxAgeMs` → only newest
    `keepNewest` survive (count rule independent of age).
  - Non-archived rows never deleted regardless of age (archived-only guarantee).
  - Cascade: a victim's `reviews` row is gone; a survivor's `reviews` row remains;
    `signals` untouched.
  - Legacy null `archivedAt` row sorts/expires via the `COALESCE` fallback rather than
    throwing or being mis-ranked.
  - Returns accurate deleted-count.
- Settings/API test: `GET` exposes the flag + display constants; `PUT` boolean patch
  flips `config` and persists; sweep is skipped when disabled.

## Out of scope

- Per-repo retention or configurable thresholds via UI (named constants only).
- Sweeping stale non-archived rows (reconcile/poller territory).
- Changing the `signals` 60-day prune.
- `VACUUM` / physical file shrink (SQLite reuses freed pages; not needed for row counts
  at this scale).
