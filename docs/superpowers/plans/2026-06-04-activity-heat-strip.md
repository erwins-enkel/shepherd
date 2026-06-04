# Per-agent activity heat-strip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace each session row's "active 5s ago" text with a 24-cell rolling 8-minute activity heat-strip that reads busy/bursty/quiet at a glance and drains to empty exactly when the agent stalls.

**Architecture:** The poller already parses each running session's transcript every tick and pushes a `SessionActivity` signal over the `session:activity` SSE event. We carry two compact arrays of recent tool-use timestamps in that existing signal (no new endpoint, no per-row polling, no DB change). The client buckets them against the `nowMs` clock it already ticks, so the strip ages/drains live between pushes. Bucketing is a pure, unit-tested function; the Svelte component is thin.

**Tech stack:** Bun + TypeScript (root server, tests via `bun test`); SvelteKit 5 + Tailwind 4 + Paraglide i18n + vitest (UI). Spec: `docs/superpowers/specs/2026-06-04-activity-heat-strip-design.md`.

**Prerequisite (fresh worktree):** install deps once before running any checks:
```bash
bun install            # root
cd ui && bun install   # UI
```

---

### Task 1: Server — carry recent timestamps in `SessionActivity`

**Files:**
- Modify: `src/activity-signal.ts`
- Test: `test/activity-signal.test.ts`

- [ ] **Step 1: Update the existing whole-object assertion (it will break once the shape grows)**

In `test/activity-signal.test.ts`, replace the body of the test `"signalFrom: heartbeat ts + meaningful summary from parsed entries"` (around line 163-167) with the new expected shape:

```ts
test("signalFrom: heartbeat ts + meaningful summary from parsed entries", () => {
  const entries = [entry("Read", "read a.ts", 1_000), entry("Edit", "edited b.ts", 2_000)];
  const signal = signalFrom(entries, 5_000);
  expect(signal).toEqual({
    lastActivityTs: 5_000,
    summary: "edited b.ts",
    recentTs: [1_000, 2_000],
    recentErrTs: [],
  });
});
```

- [ ] **Step 2: Add failing tests for the new windowing + error tagging**

Append to `test/activity-signal.test.ts`:

```ts
// ── signalFrom: recentTs / recentErrTs windowing ──────────────────────────────

test("signalFrom: recentTs keeps only events within 8min of lastActivityTs", () => {
  const last = 10_000_000;
  const entries = [
    entry("Read", "old", last - 9 * 60_000), // outside 8min window → dropped
    entry("Read", "in", last - 60_000), // inside
    entry("Edit", "newer", last - 1_000), // inside
  ];
  const signal = signalFrom(entries, last);
  expect(signal!.recentTs).toEqual([last - 60_000, last - 1_000]);
  expect(signal!.recentErrTs).toEqual([]);
});

test("signalFrom: recentErrTs is the subset of recentTs whose tool errored", () => {
  const last = 10_000_000;
  const entries = [
    entry("Bash", "$ ok", last - 30_000, "ok"),
    entry("Bash", "$ boom", last - 10_000, "error"),
  ];
  const signal = signalFrom(entries, last);
  expect(signal!.recentTs).toEqual([last - 30_000, last - 10_000]);
  expect(signal!.recentErrTs).toEqual([last - 10_000]);
});

test("signalFrom: zero-ts entries are excluded from recentTs", () => {
  const signal = signalFrom([entry("Read", "no ts", 0)], 5_000);
  expect(signal!.recentTs).toEqual([]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test ./test/activity-signal.test.ts`
Expected: FAIL — `recentTs`/`recentErrTs` are `undefined` (property does not exist yet).

- [ ] **Step 4: Extend the type and derivation in `src/activity-signal.ts`**

Add `DEFAULT_STALL` to the existing stall import (line 3):

```ts
import { snapshotFrom, DEFAULT_STALL, type ActivitySnapshot } from "./stall";
```

Extend the `SessionActivity` interface (after the `summary` field, ~line 11):

```ts
export interface SessionActivity {
  /** ms epoch of the newest transcript record — the heartbeat. 0 if none yet. */
  lastActivityTs: number;
  /** Latest *meaningful* tool-use summary, verbatim (e.g. "edited poller.ts",
   *  "$ bun test"); null when the agent has produced no tool-use yet. */
  summary: string | null;
  /** ms-epoch timestamps of in-window tool-use events (oldest→newest) for the
   *  row heat-strip. Empty when no recent activity. */
  recentTs: number[];
  /** Subset of `recentTs` whose tool-use errored; the client tints those slices red. */
  recentErrTs: number[];
}
```

Add the window constant just above `signalFrom`:

```ts
/** Rolling span the row heat-strip covers. Equals the stall threshold so a
 *  fully-drained strip coincides with the stall alarm. */
export const STRIP_WINDOW_MS = DEFAULT_STALL.stallMs;
```

Replace the body of `signalFrom` with:

```ts
export function signalFrom(
  entries: ActivityEntry[],
  lastActivityTs: number,
): SessionActivity | null {
  const summary = latestMeaningfulSummary(entries);
  // no signal yet — transcript exists but contains no parseable activity
  if (lastActivityTs === 0 && summary === null) return null;
  const cutoff = lastActivityTs - STRIP_WINDOW_MS;
  const recentTs: number[] = [];
  const recentErrTs: number[] = [];
  for (const e of entries) {
    if (e.ts <= 0 || e.ts < cutoff || e.ts > lastActivityTs) continue;
    recentTs.push(e.ts);
    if (e.status === "error") recentErrTs.push(e.ts);
  }
  return { lastActivityTs, summary, recentTs, recentErrTs };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/activity-signal.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Lint + typecheck the server**

Run: `bun run lint && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/activity-signal.ts test/activity-signal.test.ts
git commit -m "feat(activity): carry recent tool-use timestamps in SessionActivity"
```

---

### Task 2: UI — mirror the `SessionActivity` shape

**Files:**
- Modify: `ui/src/lib/types.ts:186-191`
- Test: `ui/src/lib/store.svelte.test.ts:342,354` (fixtures the new fields)

- [ ] **Step 1: Add the fields to the UI type**

In `ui/src/lib/types.ts`, replace the `SessionActivity` interface (lines 186-191) with:

```ts
export interface SessionActivity {
  /** ms epoch of the newest transcript record — the heartbeat. 0 if none yet. */
  lastActivityTs: number;
  /** Latest meaningful tool-use summary, verbatim (e.g. "edited poller.ts", "$ bun test"); null if no tool-use yet. */
  summary: string | null;
  /** ms-epoch timestamps of in-window tool-use events (oldest→newest) for the row heat-strip. */
  recentTs: number[];
  /** Subset of recentTs whose tool-use errored; the client tints those slices red. */
  recentErrTs: number[];
}
```

- [ ] **Step 2: Fix the store test fixtures so they satisfy the type**

In `ui/src/lib/store.svelte.test.ts`, update the two `SessionActivity` literals:

Line 342:
```ts
const ACTIVITY: SessionActivity = {
  lastActivityTs: 1000,
  summary: "edited poller.ts",
  recentTs: [1000],
  recentErrTs: [],
};
```

Line 354 (inside the test):
```ts
  const updated: SessionActivity = {
    lastActivityTs: 2000,
    summary: "$ bun test",
    recentTs: [2000],
    recentErrTs: [],
  };
```

- [ ] **Step 3: Typecheck + run the store tests**

Run: `cd ui && bun run check && bun run test src/lib/store.svelte.test.ts`
Expected: no type errors; store tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/store.svelte.test.ts
git commit -m "feat(ui): mirror recentTs/recentErrTs on SessionActivity type"
```

---

### Task 3: UI — pure heat-strip bucketing

**Files:**
- Create: `ui/src/lib/heartbeat.ts`
- Test: `ui/src/lib/heartbeat.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/heartbeat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { bucketStrip, STRIP_CELLS, STRIP_WINDOW_MS } from "./heartbeat";

const NOW = 10_000_000;

describe("bucketStrip", () => {
  it("returns exactly STRIP_CELLS cells", () => {
    expect(bucketStrip([], [], NOW)).toHaveLength(STRIP_CELLS);
  });

  it("empty input → all level-0, no error, no now", () => {
    const cells = bucketStrip([], [], NOW);
    expect(cells.every((c) => c.level === 0 && !c.error && !c.now)).toBe(true);
  });

  it("the most recent event lands in the last (rightmost) cell and is marked now", () => {
    const cells = bucketStrip([NOW - 1_000], [], NOW);
    expect(cells[STRIP_CELLS - 1].level).toBe(1);
    expect(cells[STRIP_CELLS - 1].now).toBe(true);
    expect(cells.filter((c) => c.now)).toHaveLength(1);
  });

  it("the oldest in-window event lands at or near the first cell", () => {
    const ts = NOW - (STRIP_WINDOW_MS - 1); // just inside the window
    const cells = bucketStrip([ts], [], NOW);
    expect(cells[0].level).toBe(1);
  });

  it("events at or beyond the window, and future events, are dropped", () => {
    const cells = bucketStrip([NOW - STRIP_WINDOW_MS, NOW + 5_000, 0], [], NOW);
    expect(cells.every((c) => c.level === 0)).toBe(true);
  });

  it("level scales with count and caps at 4", () => {
    const t = NOW - 1_000; // all in the same (last) cell
    expect(bucketStrip([t], [], NOW)[STRIP_CELLS - 1].level).toBe(1);
    expect(bucketStrip([t, t], [], NOW)[STRIP_CELLS - 1].level).toBe(2);
    expect(bucketStrip([t, t, t, t, t, t], [], NOW)[STRIP_CELLS - 1].level).toBe(4);
  });

  it("a cell holding an errored ts is marked error", () => {
    const t = NOW - 1_000;
    const cells = bucketStrip([t], [t], NOW);
    expect(cells[STRIP_CELLS - 1].error).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && bun run test src/lib/heartbeat.test.ts`
Expected: FAIL — cannot resolve `./heartbeat`.

- [ ] **Step 3: Implement `ui/src/lib/heartbeat.ts`**

```ts
/** Heat-strip bucketing for the per-agent activity row indicator. Pure + unit-tested. */

/** Number of cells in the strip. Fixed; CSS scales each cell's width. */
export const STRIP_CELLS = 24;

/** Rolling window the strip spans. Equals the server's 8-min stall threshold
 *  (src/stall.ts DEFAULT_STALL.stallMs), so a fully-drained strip coincides with
 *  the stall alarm. Kept as a literal because the UI does not import server code. */
export const STRIP_WINDOW_MS = 8 * 60_000;

const CELL_MS = STRIP_WINDOW_MS / STRIP_CELLS;

export interface StripCell {
  /** Intensity 0 (empty track) … 4 (busiest), from the event count in this slice. */
  level: number;
  /** A tool-use in this slice errored — render red. */
  error: boolean;
  /** This slice holds the single newest event — render brightest. */
  now: boolean;
}

/** Map an event count in one slice to an intensity level (0–4). */
function levelFor(count: number): number {
  if (count <= 0) return 0;
  if (count >= 4) return 4;
  return count;
}

/**
 * Bucket in-window tool-use timestamps into a fixed STRIP_CELLS-long strip,
 * oldest slice first, newest (now) slice last. `nowMs` anchors the window so the
 * strip ages/drains live between server pushes. Zero/out-of-window/future ts are
 * ignored.
 */
export function bucketStrip(
  recentTs: number[],
  recentErrTs: number[],
  nowMs: number,
): StripCell[] {
  const counts = new Array<number>(STRIP_CELLS).fill(0);
  const errs = new Array<boolean>(STRIP_CELLS).fill(false);
  const errSet = new Set(recentErrTs);
  let newestTs = -1;
  let newestIdx = -1;

  for (const ts of recentTs) {
    if (ts <= 0) continue;
    const age = nowMs - ts;
    if (age < 0 || age >= STRIP_WINDOW_MS) continue;
    const idx = STRIP_CELLS - 1 - Math.floor(age / CELL_MS);
    if (idx < 0 || idx >= STRIP_CELLS) continue;
    counts[idx]++;
    if (errSet.has(ts)) errs[idx] = true;
    if (ts > newestTs) {
      newestTs = ts;
      newestIdx = idx;
    }
  }

  return counts.map((c, i) => ({ level: levelFor(c), error: errs[i], now: i === newestIdx }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && bun run test src/lib/heartbeat.test.ts`
Expected: PASS (all `bucketStrip` tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/heartbeat.ts ui/src/lib/heartbeat.test.ts
git commit -m "feat(ui): pure heat-strip bucketing for activity strip"
```

---

### Task 4: UI — `HeartbeatStrip.svelte` component

**Files:**
- Create: `ui/src/lib/components/HeartbeatStrip.svelte`

Reuses existing i18n keys `activity_active` ("active {ago} ago") and `activity_starting` ("starting…") for the aria-label — no new message keys, so the `check:i18n` parity gate stays green.

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import { formatAgo } from "$lib/format";
  import { bucketStrip } from "$lib/heartbeat";
  import { m } from "$lib/paraglide/messages";
  import type { SessionActivity } from "$lib/types";

  let { activity, nowMs }: { activity?: SessionActivity; nowMs: number } = $props();

  // Bucket against nowMs (not the server's push time) so the strip ages/drains live.
  const cells = $derived(bucketStrip(activity?.recentTs ?? [], activity?.recentErrTs ?? [], nowMs));

  // Screen-reader text: reuse the existing recency phrasing; "starting" before the first beat.
  const label = $derived(
    activity && activity.lastActivityTs > 0
      ? m.activity_active({ ago: formatAgo(nowMs - activity.lastActivityTs) })
      : m.activity_starting(),
  );
</script>

<span class="strip" role="img" aria-label={label}>
  {#each cells as cell, i (i)}
    <span class="cell" class:err={cell.error} class:now={cell.now} data-level={cell.level} aria-hidden="true"
    ></span>
  {/each}
</span>

<style>
  /* 24 equal cells; intensity via opacity on currentColor, so it follows the
     theme's running-green. No motion — StatusPip already pulses (matches the
     prior Heartbeat.svelte decision). */
  .strip {
    display: inline-flex;
    align-items: stretch;
    gap: 1px;
    width: 132px;
    max-width: 40vw;
    height: 12px;
    flex: none;
    color: var(--status-running);
  }
  .cell {
    flex: 1 1 0;
    border-radius: 1px;
    background: currentColor;
    opacity: 0.12; /* level 0 = faint empty track */
  }
  .cell[data-level="1"] {
    opacity: 0.35;
  }
  .cell[data-level="2"] {
    opacity: 0.6;
  }
  .cell[data-level="3"] {
    opacity: 0.82;
  }
  .cell[data-level="4"] {
    opacity: 1;
  }
  .cell.now {
    opacity: 1;
  }
  /* an errored slice (always level ≥ 1) renders red instead of green */
  .cell.err {
    color: var(--color-red);
    opacity: 0.85;
  }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && bun run check`
Expected: no errors (the component is not yet referenced; this just verifies it compiles).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/HeartbeatStrip.svelte
git commit -m "feat(ui): HeartbeatStrip component renders the activity heat-strip"
```

---

### Task 5: UI — swap the strip onto the row, retire `Heartbeat.svelte`

**Files:**
- Modify: `ui/src/lib/components/UnitRow.svelte` (import line 13, usage line 151, responsive block ~512-527)
- Delete: `ui/src/lib/components/Heartbeat.svelte`

`Heartbeat.svelte` is referenced only by `UnitRow.svelte` (verified: no test or other component imports it), so it can be removed once the row swaps.

- [ ] **Step 1: Swap the import**

In `ui/src/lib/components/UnitRow.svelte`, change line 13:

```svelte
  import HeartbeatStrip from "./HeartbeatStrip.svelte";
```

- [ ] **Step 2: Swap the usage**

Change line 151 inside the `.u-activity` block:

```svelte
          <HeartbeatStrip {activity} {nowMs} />
```

- [ ] **Step 3: Shrink the strip in the narrow-sidebar container query**

In the `@container herd (max-width: 300px)` block (around line 512), add a rule so the strip stays the (now tiny) heartbeat without crowding the row. Place it alongside the existing `.act-sum, .act-sep, .meta-stepper { display: none }` rule:

```css
    /* the strip IS the heartbeat here — keep it, just narrower */
    :global(.strip) {
      width: 64px;
    }
```

- [ ] **Step 4: Delete the retired component**

```bash
git rm ui/src/lib/components/Heartbeat.svelte
```

- [ ] **Step 5: Typecheck (catches any lingering reference to the deleted file)**

Run: `cd ui && bun run check`
Expected: no errors. If `check` reports an unused/undefined `Heartbeat`, fix the reference.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/UnitRow.svelte
git commit -m "feat(ui): replace row heartbeat dot+text with activity heat-strip"
```

---

### Task 6: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Root server — lint, typecheck, tests**

Run: `bun run lint && bunx tsc --noEmit && bun test ./test`
Expected: all PASS.

- [ ] **Step 2: UI — check, i18n parity, tests**

Run: `cd ui && bun run check && bun run check:i18n && bun run test`
Expected: all PASS (i18n parity green — no new keys were added).

- [ ] **Step 3: Confirm the strip renders in the running app**

Per the `verify` / `run` skill: launch the app, open the herd, and confirm a running session row shows the heat-strip (filled cells trailing to the right, summary still beside it) and that an idle row's strip has drained toward empty. Capture a screenshot.

- [ ] **Step 4: Final commit (only if Step 3 required any tweak)**

```bash
git add -A
git commit -m "chore(ui): heat-strip verification fixups"
```

---

## Self-review notes

- **Spec coverage:** density heat-strip (Task 4 CSS) ✓; rolling 8-min wall-clock window (`STRIP_WINDOW_MS`, Tasks 1 & 3) ✓; 24 fixed cells (Task 3) ✓; replaces "active 5s ago", summary stays (Task 5) ✓; data via existing SSE signal, no new endpoint/DB (Task 1) ✓; live drain via `nowMs` (Task 3/4) ✓; red error slices (Tasks 1,3,4) ✓; empty/new = faint track (Task 3 empty input → level 0, Task 4 `.cell` base opacity) ✓; no motion (Task 4) ✓; a11y role=img + i18n label (Task 4) ✓; reuse `formatAgo` (Task 4) ✓.
- **Deviation from spec:** the spec floated a *separate dot fallback* on mobile; this plan instead keeps the strip and shrinks it (Task 5 Step 3) — simpler, and the strip degrades cleanly. Also no new i18n keys: the aria-label reuses `activity_active`/`activity_starting` rather than adding `heartbeatstrip_*`, keeping the catalogs DRY and parity-safe.
- **Type consistency:** `recentTs: number[]` / `recentErrTs: number[]` identical across `src/activity-signal.ts`, `ui/src/lib/types.ts`, and the `bucketStrip(recentTs, recentErrTs, nowMs)` signature; `StripCell { level, error, now }` consistent between `heartbeat.ts` and the component.
