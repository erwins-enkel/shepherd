# Merge-train "Merging" in-progress marker

**Date:** 2026-06-08
**Status:** Approved (design)

## Problem

The "Merge train" shortcut (in the Ready-to-merge group header, #359) launches a
new agent session that merges the repo's ready PRs in sequence. While that train
runs, the PRs it is working through keep their green **READY** badge and stay in
the "Ready to merge" group. The operator gets no signal that those PRs are now
in flight — they look identical to PRs nobody has touched, and a second train or
manual merge could be kicked off against the same set.

Mark the PRs that a launched train is working through as **Merging**: pull them
into their own group with an amber, pulsing badge, and clear the mark per-PR as
each one actually lands.

## Mechanism constraint

The train runs **entirely client-side** as a Claude agent session — the server
never learns a train is in flight on its own. So the client, which already knows
exactly which PR-sessions it scoped into the train (`collectReadyPrs` /
`pickTrainRepo`), must tell the server. The server is then authoritative:
persists the mark, broadcasts it, and owns clearing. This gives refresh
resilience and cross-device sync (chosen over a client-only store).

## Data model

Two transient fields on `Session` (both server `src/types.ts` and UI
`ui/src/lib/types.ts`), mirroring the existing `readyToMerge` / `autopilotQuestion`
nullable-transient patterns:

- `mergingSince: number | null` — epoch ms when the train marked this PR; `null`
  when not merging.
- `mergingTrainId: string | null` — id of the merge-train session that owns this
  mark. Powers set-clearing when that train session is archived (see Clear #2).

### Persistence (`src/store.ts`)

Follow the `readyToMerge` column exactly:
- `migrateSessionColumns()`: `ALTER TABLE sessions ADD COLUMN mergingSince INTEGER`
  and `... mergingTrainId TEXT` (both nullable, no default).
- Insert defaults: `mergingSince = null`, `mergingTrainId = null`.
- `update()` patch `Pick<>`: add both fields, and include them in the `UPDATE`
  statement column list.
- `hydrate()`: `mergingSince: r.mergingSince ?? null`, `mergingTrainId: r.mergingTrainId ?? null`.
- `NewSession` omit list: add both.

## Server flow

### Set
- **Service** (`src/service.ts`): `setMerging(ids: string[], trainId: string)` —
  for each id `store.update(id, { mergingSince: Date.now(), mergingTrainId: trainId })`
  and `events.emit("session:merging", { id, since })`.
- **Endpoint** (`src/server.ts`): `POST /api/merge-train/start`, body
  `{ ids: string[]; trainId: string }`. Validate JSON content-type + shape
  (mirror `handleSessionReady`). Unknown ids are skipped (not an error — the set
  is best-effort). Returns `{ ok: true }`.

### Clear
A single helper `clearMerging(id)` does `store.update(id, { mergingSince: null,
mergingTrainId: null })` + `emit("session:merging", { id, since: null })`. Three
triggers, in order of how they fire in practice:

1. **Per-PR on merge (primary, visible):** subscriber on `session:git` — when a
   session that has `mergingSince` set transitions to `git.state === "merged"`
   or `"closed"`, `clearMerging(id)`. PRs visibly resolve one-by-one as the
   train works. (Lives alongside the existing `session:git` consumers; covers
   all sessions, not just `auto` ones like `drain.onGit`.)
2. **Train archived (straggler set-clear):** subscriber on `session:archived` —
   clear every session whose `mergingTrainId` equals the archived session's id.
   Keyed on **archived** (a terminal state), deliberately **not** `done`/idle:
   a Claude pane reports `done` when it finishes a turn and sits at the train's
   human approval gate — clearing there would wipe the marks mid-train.
3. **TTL backstop:** `PrPoller.tick()` sweep — any session with `mergingSince`
   older than `MERGE_STALE_MS` (30 min) gets `clearMerging`. Guarantees a
   rejected/held-back PR (never merged, train never archived) can't stay marked
   forever. 30 min comfortably exceeds a slow real train (sequential merges +
   re-check + approval gate); it only bounds rejected-PR cleanup latency.

### Broadcast
One event reused for set and clear: `session:merging` `{ id, since: number | null }`
(`null` = cleared). Flows through the existing `EventHub → WebSocket` pipeline
(`src/events.ts`, `src/server.ts` `/events`). Add `session:merging` to the
server `WsEvent` union.

## UI flow

### Launch wiring (`ui/src/routes/+page.svelte` `onmergetrain`)
After `createSession(...)` resolves, call `api.startMergeTrain(prSessionIds, train.id)`
with the ids from the already-collected `prs` list. Marking failure is
**fail-soft**: toast the error, the train still runs — only the badges are
degraded. (The train launch itself is the load-bearing action; marking is
cosmetic.)

### Client (`ui/src/lib/api.ts`, types, store)
- `api.startMergeTrain(ids: string[], trainId: string): Promise<void>` — `POST`
  to `/api/merge-train/start`, fire-and-forget shape like `setReadyToMerge`.
- `ui/src/lib/types.ts`: add the two `Session` fields; add `session:merging` to
  the `WsEvent` union.
- `ui/src/lib/store.svelte.ts`: handle `session:merging` — patch the row's
  `mergingSince` (and clear `mergingTrainId` when `since` is null). No refetch,
  same as `session:ready`.
- `isMerging(s)` helper (in `merge-train.ts`): `s.mergingSince != null &&
  Date.now() - s.mergingSince < MERGE_STALE_MS`. The client-side staleness guard
  mirrors the server TTL so a stale flag never renders even if the server sweep
  is briefly behind.

### Partition (`ui/src/lib/components/herd-partition.ts`)
Add a `merging` bucket. Priority: `merged > merging > ready > reviewerRunning >
ciRunning > ciFailed > awaitingMerge > active`. `else if (isMerging(s))` sits
**above** the `readyToMerge` branch so in-train PRs are pulled out of "Ready to
merge". (A PR that has actually merged still wins the `merged` bucket — and its
mark is cleared by Clear #1 anyway.)

### Render
- **Group** (`ui/src/lib/components/Herd.svelte`): a new "Merging" group section
  rendered above "Ready to merge", mirroring the ready group's markup (header +
  count + rows). Header copy: **"Merging"**.
- **Badge** (`ui/src/lib/components/UnitRow.svelte`): an amber, pulsing
  **MERGING** badge, branched ahead of the `readyToMerge` → READY branch
  (`{#if isMerging(session)} … {:else if session.readyToMerge} …`).
- **Color/pip** (`ui/src/lib/format.ts`): amber for the merging state; pip
  variant with a subtle pulse (reuse the existing "working" amber + pulse
  treatment for visual consistency).

## House-rule obligations (same PR)

- **i18n** (`ui/messages/en.json` + `de.json`, parity enforced by `check:i18n`):
  - `status_merging` — the badge label.
  - `herd_merging_group` — the group header ("Merging").
  - a count key if the group header shows a count (match how the ready group does it).
- **Feature catalog** (`ui/src/lib/feature-announcements.ts`): one
  `FeatureAnnouncement` (stable kebab `id`, `sinceVersion` = the shipping
  release, `titleKey` + `bodyKey`), plus those two message keys in both locales.
  This is user-facing UI, so the catalog gate requires it.

## Out of scope / YAGNI

- No "cancel merge train" control. (Marks clear via merge / archive / TTL.)
- No server-side execution of the train; it stays a client-launched agent session.
- No per-PR progress beyond merged/not — the badge is binary "in this train".

## Testing

- **Server unit:** `setMerging` stamps + emits for each id and skips unknowns;
  `session:git` merged/closed clears one PR; `session:archived` clears the whole
  train set by `mergingTrainId`; TTL sweep clears a session past `MERGE_STALE_MS`
  and leaves a fresh one. Persistence round-trip (set → hydrate) keeps the fields.
- **UI unit:** `isMerging` respects the TTL boundary; `herd-partition` routes a
  merging session into the merging bucket and out of ready, and a merged session
  still wins `merged`; store applies `session:merging` set and clear.
- **i18n/catalog gates:** `cd ui && bun run check:i18n` and
  `scripts/check-feature-catalog.sh` pass.

## Open questions

None — TTL 30 min, amber pulse badge, header "Merging", dedicated
`POST /api/merge-train/start` endpoint all confirmed.
