# Queued-drain list popover

## Problem

The `QueueStrip` band shows one row per drain-enabled repo with counts only —
`inflight X/max` and `queued N`. The `queued` value is a bare number; the actual
backlog issues waiting to be drained are never sent to the client, so an operator
can't see *what's* queued without leaving the app for the forge.

## Goal

Click the `queued N` indicator for a repo → a popover lists the queued backlog
issues (issue `#` + title), each opening the issue in the forge on click.

## Decisions (settled with the user)

- **Data delivery:** lazy endpoint fetched on popover open — `GET /api/drain/queue?repo=<path>`.
  The high-frequency `drain:status` WS event stays count-only (matches the
  project's lean-WS posture).
- **Item content:** issue `#` + title; clicking a row opens the issue URL in a new
  tab. No priority badge, no ordinal/age (items still render in drain order).
- **Trigger:** the `queued N` indicator itself. Inert (plain span) when `queued`
  is 0; interactive button when > 0.

## Server

### `src/drain.ts`

```ts
export interface QueuedItem { number: number; title: string; url: string; }
```

New side-effect-free method on `DrainService`:

```ts
async queue(repoPath: string): Promise<QueuedItem[]>
```

- Reuses `buildState(repoPath)` (forge-cached via `listIssues`).
- Returns `[]` when drain is disabled for the repo (mirrors `snapshot()` skipping
  disabled repos).
- Otherwise filters `state.candidates` not in `state.mappedIssueNumbers` — the
  exact set `toStatus` counts as `queued` — preserving `selectCandidates` order,
  mapped to `{ number, title, url }`.

### `src/server.ts`

- Extend the `deps.drain` type: `queue(repoPath: string): Promise<QueuedItem[]>`.
- In `handleDrain`, before the bare-`drain` snapshot case:
  `GET /api/drain/queue?repo=<path>` (`parts[2] === "queue"`) →
  `safeRepoDir(repo, config.repoRoot)`; 400 on invalid repo;
  `json(await deps.drain?.queue(dir) ?? [])`.

### `src/index.ts`

Add `queue: (repoPath) => drain.queue(repoPath)` to the `drain` dep alongside the
existing `snapshot`.

## UI

### `ui/src/lib/types.ts`

```ts
export interface QueuedItem { number: number; title: string; url: string; }
```

### `ui/src/lib/api.ts`

```ts
export async function getDrainQueue(repoPath: string): Promise<QueuedItem[]> {
  return getJson(`/api/drain/queue?repo=${encodeURIComponent(repoPath)}`, "drain-queue");
}
```

### `ui/src/lib/components/QueueStrip.svelte`

- Render `qs-queued` as a `<button>` when `d.enabled && d.queued > 0`, else a plain
  span. `aria-expanded`, `aria-haspopup="dialog"`.
- On open: fetch `getDrainQueue(d.repoPath)`, toggle a popover anchored to that row.
  Only one repo's queue open at a time. Re-fetch each open (fresh).
- Popover: title (repo basename), then a list of `#<n> <title>` rows, each an
  `<a href={url} target="_blank" rel="noopener noreferrer">`. Loading, empty, and
  error states.
- Dismiss on `Escape` and click-outside (mirrors the `GitRail` / `TopBar` popover
  pattern).

### i18n (`ui/messages/{en,de}.json`)

New keys (snake_case, `queue_` / `drain_queue_` prefix), EN + DE parity:
popover title, open-trigger aria-label, per-item open aria-label, loading
(reuse `common_loading`), empty state, error state.

## Tests

- **`test/drain.test.ts`** — `queue()` returns mapped/ordered candidates; excludes
  already-mapped issues; `[]` when drain disabled.
- **`test/server-drain.test.ts`** — route returns the list; 400 on invalid repo;
  `[]` when `deps.drain` absent.
- **UI** — pure helper (queue trigger active?) unit test if extracted; component
  test that the button renders only when `queued > 0` and toggles the popover.

## Out of scope

WS-embedded queue payloads, priority/age decoration, queue reordering or removal
from the UI.
