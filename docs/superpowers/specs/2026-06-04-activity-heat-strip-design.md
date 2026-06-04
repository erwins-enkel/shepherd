# Per-agent activity heat-strip

**Date:** 2026-06-04
**Status:** Approved (design)

## Problem

Each session row shows liveness as a single dot plus "active 5s ago" text
(`Heartbeat.svelte`, driven by `SessionActivity.lastActivityTs`). That conveys
only the *last* beat — not the rhythm leading up to it. An operator scanning the
herd can't tell a steadily-working agent from a bursty one from one that has
gone quiet but not yet stalled.

The full per-event timeline already exists server-side (the poller parses the
transcript every tick) but is discarded down to a single timestamp before it
reaches the row.

## Solution

Replace the row's "active 5s ago" text with a **24-cell horizontal heat-strip**:

- Each cell is a ~20s slice of a **rolling 8-minute wall-clock window**.
- Cell brightness encodes how many tool-use events landed in that slice.
- The newest slice (right edge) is the brightest; older slices dim left.
- The window length equals the existing **8-min stall threshold**
  (`DEFAULT_STALL.stallMs`), so a strip drained to empty *is* the stall — the
  visual and the alarm are the same fact.
- The verbatim tool summary (`· edited poller.ts`) stays to its right — it is
  the one thing the strip cannot show.

This was chosen over (a) EKG-style per-event ticks and (b) a true sparkline
waveform; the density heat-strip reads "where bursts and lulls fell" most
clearly at row scale. A wall-clock window was chosen over event-indexed or
whole-session-compressed windows because only a time-based window makes a stall
visible (the strip drains).

## Data flow

No new endpoint, no per-row polling, no DB change.

1. `SessionActivity` (`src/activity-signal.ts`) gains a field:
   ```ts
   /** ms-epoch timestamps of tool-use events within the rolling window,
    *  oldest→newest, for the row heat-strip. Empty when no recent activity. */
   recentTs: number[];
   ```
2. `signalFrom(entries, lastActivityTs)` derives `recentTs` from the
   already-parsed `entries` (each has `ts`): keep timestamps within the last
   `STRIP_WINDOW_MS` (= `stallMs`, 8 min) of `lastActivityTs`. Entries that
   errored are tracked so the client can tint their slice (see below).
3. Pushed via the existing `session:activity` SSE event and bootstrap snapshot.
   Dedup is unchanged (`JSON.stringify(activity)`), so the signal is re-emitted
   exactly when activity changes — `recentTs` adds no extra push frequency.
4. The client buckets `recentTs` against the `nowMs` clock the row already ticks
   for the heartbeat. Between SSE pushes the strip **ages and drains live** as
   `nowMs` advances, with no server traffic.

### Window vs parse limit

`parseActivity` currently keeps the last `DEFAULT_LIMIT = 30` entries. Thirty
events comfortably cover most 8-min windows; for a very busy agent the earliest
in-window slices may undercount, which only affects relative intensity, not
correctness. If undercounting proves visible, raise the limit on the
signal-producing path only. Not addressed in v1.

## Error semantics

A slice that contains at least one errored tool-use renders **red-toned**
instead of green, so a recent failure stays visible at row scale. To carry this,
`recentTs` is paired with error information. Chosen shape:

```ts
recentTs: number[];          // all in-window tool-use timestamps
recentErrTs: number[];       // subset that errored
```

(Two parallel arrays keep the signal compact and JSON-dedup-friendly; the client
marks a slice red if any `recentErrTs` falls in it.)

## Component

New `HeartbeatStrip.svelte` replaces `Heartbeat.svelte` on the row
(`UnitRow.svelte`, the `u-activity` line). It keeps the existing prop shape
`{ activity?: SessionActivity, nowMs: number }`.

Rendering:

- Bucket `recentTs` into 24 cells by `(nowMs - ts)` over `STRIP_WINDOW_MS`.
- Per cell: count → intensity step; any error ts in cell → red ramp.
- Intensity scale: 5 steps — empty track → dim → mid → bright → brightest. The
  rightmost (now) cell uses the brightest step. Scale is relative and capped.
- **No motion.** The now-cell is the brightest *static* cell, matching the
  existing deliberate no-motion rule in `Heartbeat.svelte` ("StatusPip already
  pulses").

States:

- **New session / no events:** faint empty 24-cell track (no "starting…" text);
  reads "alive, nothing yet".
- **Live gate:** the strip inherits the row's existing `live` gate — when the
  row hides the activity line, the strip is absent too.
- **Stale/drained:** in-window cells age out; a fully empty strip == stalled.

Responsive:

- The strip shrinks with the row. Below the existing row collapse breakpoint
  (where the summary is already dropped), fall back to the current single status
  dot rather than a cramped strip.

Accessibility (house rule):

- `role="img"` with an i18n `aria-label` summarizing the state, e.g.
  "active, last event 3s ago" / "idle 6m". New keys in **both** `en.json` and
  `de.json`. The strip cells themselves are `aria-hidden`.

## Internationalization

The strip's only user-facing text is the `aria-label`. Add component-prefixed
snake_case keys (e.g. `heartbeatstrip_active`, `heartbeatstrip_idle`) to both
locale catalogs. Tool summaries pass through verbatim (not translated), as today.

## Out of scope

- The `ActivityFeed` panel (text list of events) is unchanged.
- No DB schema change; no new HTTP endpoint.
- No change to stall detection itself — the strip only *reflects* the existing
  8-min threshold.

## Affected files

- `src/activity-signal.ts` — add `recentTs` / `recentErrTs`; derive in `signalFrom`.
- `src/activity.ts` — `ActivityEntry` already carries `ts` + `status`; confirm
  error status reaches the signal builder.
- `ui/src/lib/types.ts` — mirror the `SessionActivity` field additions.
- `ui/src/lib/components/HeartbeatStrip.svelte` — new component.
- `ui/src/lib/components/UnitRow.svelte` — swap `Heartbeat` → `HeartbeatStrip`.
- `ui/src/lib/components/Heartbeat.svelte` — removed (or kept only if still used elsewhere; verify).
- `ui/messages/en.json`, `ui/messages/de.json` — new aria-label keys.
- Tests: `test/activity-signal.test.ts` (recentTs derivation, error tagging,
  window edges); UI component test for bucketing + edge states.

## Resolved decisions

- **aria-label** reuses `formatAgo` for the "Ns/Nm ago" portion of the label.
- **Cell count is fixed at 24**; CSS scales each cell's width to the available
  space (no dynamic cell count).
