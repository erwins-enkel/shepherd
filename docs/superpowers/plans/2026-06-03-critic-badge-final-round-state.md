# Tri-state Critic Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the critic badge's single `stalled` state into "final round in flight" (dimmed `FINAL`) vs. genuinely stalled (orange `STALLED`), so a session isn't shown as stalled while the agent is still addressing the last allowed round.

**Architecture:** Server tags each verdict with `finalRoundPending` (true only when the cap-th steer was *just* delivered: `addressRound > priorRound && addressRound >= cap`). A surfaced `finalRoundTimeoutMs` lets the UI escalate an abandoned final round to orange after 15 min. The UI badge derives a 3-way status (`round` | `final` | `stalled`) from those fields plus a shared coarse clock.

**Tech Stack:** Bun + TypeScript (server), bun:sqlite (store), SvelteKit + Svelte 5 runes (UI), Paraglide JS (i18n).

**Deviation from spec (intentional):** `finalRoundTimeoutMs` is **stored as a column** (set by `buildVerdict` from the constant), mirroring how `addressCap` is persisted — rather than injected at read-time. This avoids coupling `store.ts` to `review.ts`'s constant. A stale 15-min value on reload is harmless (it only shifts when an already-pending badge escalates).

---

### Task 1: Server — verdict fields, constant, and `finalRoundPending` logic

**Files:**
- Modify: `src/types.ts` (ReviewVerdict interface)
- Modify: `src/review.ts` (constant ~line 70, `buildVerdict` ~line 430, `finalize` ~line 364)
- Test: `test/review.test.ts`

- [ ] **Step 1: Add the two fields to the server `ReviewVerdict` type**

In `src/types.ts`, find the `ReviewVerdict` interface (the block with `addressRound` / `addressCap` / `errorRound`, ~lines 109-125) and add, right after the `errorRound` line:

```ts
  errorRound: number; // consecutive critic error verdicts (0 on real verdict)
  finalRoundPending: boolean; // cap-th steer just delivered, no re-review yet → dimmed FINAL badge
  finalRoundTimeoutMs: number; // live abandonment timeout; surfaced so the UI never hardcodes it
```

- [ ] **Step 2: Write the failing tests**

In `test/review.test.ts`, after the existing `"round cap reached: holds the round..."` test (~line 450), add:

```ts
test("advancing into the cap marks the final round pending (not yet stalled)", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ addressRound: 2 }); // one try left; cap is 3
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressRound).toBe(3); // advanced into the cap
  expect(reviews["s1"]?.finalRoundPending).toBe(true); // steer just delivered, agent working it
});

test("holding at the cap is a confirmed stall, not pending", async () => {
  const { deps: d, reviews } = makeDeps(
    {
      readVerdict: () => ({
        decision: "request-changes",
        summary: "still broken",
        body: "b",
        findings: ["still broken"],
      }),
    },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ addressRound: 3 }); // already at cap → held, no steer
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.addressRound).toBe(3);
  expect(reviews["s1"]?.finalRoundPending).toBe(false); // gave up → orange, not dimmed
});

test("clean verdict is never final-round-pending", async () => {
  const { deps: d, reviews } = makeDeps(
    { readVerdict: () => ({ decision: "comment", summary: "lgtm", body: "b", findings: [] }) },
    { autoAddressEnabled: true },
  );
  reviews["s1"] = priorReview({ addressRound: 2 });
  const svc = new ReviewService(d as any);
  await svc.consider(session(), OPEN_GREEN);
  await svc.tick();
  expect(reviews["s1"]?.finalRoundPending).toBe(false);
});
```

> Note: `priorReview(...)` is the existing helper in this file. If it does not already set `finalRoundPending`/`finalRoundTimeoutMs`, add safe defaults to it (Step 5).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test ./test/review.test.ts`
Expected: the 3 new tests FAIL (`finalRoundPending` is `undefined`).

- [ ] **Step 4: Add the constant and initialize the fields in `buildVerdict`**

In `src/review.ts`, near `const DEFAULT_CAP = 3;` (~line 70), add:

```ts
// How long a delivered final round may run before the badge escalates from dimmed
// FINAL to orange STALLED on its own (covers an agent that abandons the last round
// without re-pushing). Surfaced per-verdict as `finalRoundTimeoutMs` so the UI reads
// the live value instead of mirroring this number.
const DEFAULT_FINAL_ROUND_TIMEOUT_MS = 15 * 60_000;
```

In `buildVerdict`'s returned object (~lines 430-442), add the two fields next to `errorRound`:

```ts
      errorRound: 0, // finalize() overwrites on an error verdict
      finalRoundPending: false, // finalize() sets this on a real verdict
      finalRoundTimeoutMs: DEFAULT_FINAL_ROUND_TIMEOUT_MS, // live escalation timeout
```

- [ ] **Step 5: Set `finalRoundPending` in `finalize` and patch the test helper**

In `src/review.ts` `finalize`, in the real-verdict `else` branch, immediately after
`verdict.addressRound = this.runAutoAddress(f, verdict);` (~line 364) add:

```ts
        verdict.addressRound = this.runAutoAddress(f, verdict); // errorRound stays 0 on a real verdict
        // The cap-th steer was just delivered when the round ADVANCES into the cap
        // (priorRound < cap → addressRound === cap). The agent is now addressing that
        // final round → dimmed FINAL badge, not orange. A round HELD at the cap
        // (addressRound === priorRound) means that final round already failed re-review
        // → confirmed stall. Error verdicts hold the round, so they stay false here.
        verdict.finalRoundPending =
          verdict.findings.length > 0 &&
          verdict.addressRound >= this.cap &&
          verdict.addressRound > f.priorRound;
```

The error branch leaves `verdict.finalRoundPending` at its `false` default — no change needed there.

In `test/review.test.ts`, find the `priorReview` helper and ensure it provides the new
fields (add only if missing):

```ts
    finalRoundPending: false,
    finalRoundTimeoutMs: 15 * 60_000,
```

Also add the same two fields to the two inline verdict literals in this file (the
`forget` test ~line 288 and the `clean verdict` test ~line 392) so they satisfy the type.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test ./test/review.test.ts`
Expected: PASS (all, including the 3 new tests).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/review.ts test/review.test.ts
git commit -m "feat(critic): tag verdicts with finalRoundPending + timeout"
```

---

### Task 2: Store — persist the new fields

**Files:**
- Modify: `src/store.ts` (schema ~line 115, migration ~line 123, `hydrateReview` ~line 388, `getReview`/`putReview`/`snapshotReviews` ~lines 400-452)
- Test: `test/store.test.ts` (if present; otherwise add assertions in `test/review.test.ts` round-trip — see Step 2)

- [ ] **Step 1: Write the failing test**

Add to `test/store.test.ts` (create the `import { Store } ...` mirroring the file's existing tests; if the file is absent, place this in `test/review.test.ts` instead):

```ts
test("putReview round-trips finalRoundPending + finalRoundTimeoutMs", () => {
  const store = new Store(":memory:");
  store.putReview({
    sessionId: "s1",
    headSha: "abc",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["x"],
    addressRound: 3,
    addressCap: 3,
    errorRound: 0,
    finalRoundPending: true,
    finalRoundTimeoutMs: 900_000,
    seenNoteIds: [],
    updatedAt: 1,
  });
  const got = store.getReview("s1");
  expect(got?.finalRoundPending).toBe(true);
  expect(got?.finalRoundTimeoutMs).toBe(900_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test ./test/store.test.ts` (or `./test/review.test.ts` if you placed it there)
Expected: FAIL — `finalRoundPending` comes back `undefined` (column not stored).

- [ ] **Step 3: Add columns to the schema + migration**

In `src/store.ts`, in the `CREATE TABLE IF NOT EXISTS reviews` block (~lines 115-121), add the
two columns before `url TEXT, updatedAt INTEGER NOT NULL)`:

```sql
      seenNoteIds TEXT NOT NULL DEFAULT '[]',
      finalRoundPending INTEGER NOT NULL DEFAULT 0,
      finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000,
      url TEXT, updatedAt INTEGER NOT NULL)`);
```

In the migration block (~after line 138, alongside the other `if (!reviewCols.some(...))` guards), add:

```ts
    if (!reviewCols.some((c) => c.name === "finalRoundPending")) {
      this.db.run(`ALTER TABLE reviews ADD COLUMN finalRoundPending INTEGER NOT NULL DEFAULT 0`);
    }
    // 900000ms = 15min; one-time backfill for pre-existing rows, not an ongoing mirror —
    // live rows carry ReviewService's DEFAULT_FINAL_ROUND_TIMEOUT_MS.
    if (!reviewCols.some((c) => c.name === "finalRoundTimeoutMs")) {
      this.db.run(
        `ALTER TABLE reviews ADD COLUMN finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000`,
      );
    }
```

- [ ] **Step 4: Hydrate + read + write the new columns**

In `hydrateReview` (~line 388), add coercion (SQLite stores the bool as 0/1):

```ts
      errorRound: r.errorRound ?? 0,
      finalRoundPending: !!r.finalRoundPending,
      finalRoundTimeoutMs: r.finalRoundTimeoutMs ?? 900_000,
```

In `getReview` (~line 403) and `snapshotReviews` (~line 445) SELECT lists, add the columns:

```sql
        `SELECT sessionId, headSha, decision, summary, body, findings, addressRound,
                addressCap, errorRound, finalRoundPending, finalRoundTimeoutMs,
                seenNoteIds, url, updatedAt
              FROM reviews WHERE sessionId = ?`,
```

(and the same column additions in the `snapshotReviews` SELECT.)

In `putReview` (~lines 412-435): add the columns to the INSERT list, the `VALUES` `?`
count, the `ON CONFLICT ... DO UPDATE SET`, and the bound-params array:

```ts
      `INSERT INTO reviews (sessionId, headSha, decision, summary, body, findings, addressRound,
         addressCap, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET headSha=excluded.headSha, decision=excluded.decision,
         summary=excluded.summary, body=excluded.body, findings=excluded.findings,
         addressRound=excluded.addressRound, addressCap=excluded.addressCap,
         errorRound=excluded.errorRound, finalRoundPending=excluded.finalRoundPending,
         finalRoundTimeoutMs=excluded.finalRoundTimeoutMs, seenNoteIds=excluded.seenNoteIds,
         url=excluded.url, updatedAt=excluded.updatedAt`,
```

Params array — add after `v.errorRound ?? 0,`:

```ts
        v.errorRound ?? 0,
        v.finalRoundPending ? 1 : 0,
        v.finalRoundTimeoutMs ?? 900_000,
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test ./test/store.test.ts` (or wherever you placed the test)
Expected: PASS.

- [ ] **Step 6: Run the full server suite (guard against regressions)**

Run: `bun test ./test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat(critic): persist finalRoundPending + finalRoundTimeoutMs"
```

---

### Task 3: UI type mirror

**Files:**
- Modify: `ui/src/lib/types.ts` (ReviewVerdict, ~lines 128-140)

- [ ] **Step 1: Add the fields to the UI `ReviewVerdict`**

In `ui/src/lib/types.ts`, the `ReviewVerdict` interface is a slimmer mirror than the
server's (no `errorRound`/`seenNoteIds`). Add the two fields after `addressCap`:

```ts
  addressCap: number; // server's streak cap for this run — the badge reads it instead of mirroring
  finalRoundPending: boolean; // cap-th steer just delivered, no re-review yet → dimmed FINAL badge
  finalRoundTimeoutMs: number; // live abandonment timeout (ms); UI escalates FINAL→STALLED after this
  url?: string;
```

- [ ] **Step 2: Type-check**

Run: `cd ui && bun run check`
Expected: PASS (no consumers reference the fields yet; the interface just gains them).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/types.ts
git commit -m "feat(critic): mirror finalRound fields in UI verdict type"
```

---

### Task 4: Shared coarse clock store

**Files:**
- Create: `ui/src/lib/now.svelte.ts`

- [ ] **Step 1: Create the clock store**

```ts
// ui/src/lib/now.svelte.ts
// Shared coarse wall-clock: a single 30s tick drives time-based UI (e.g. the critic
// badge escalating an abandoned final round from dimmed FINAL to orange STALLED)
// without each component spinning up its own interval. Read `clock.current` inside a
// $derived to make that computation re-run on each tick.
class Clock {
  current = $state(Date.now());
  constructor() {
    setInterval(() => (this.current = Date.now()), 30_000);
  }
}
export const clock = new Clock();
```

- [ ] **Step 2: Type-check**

Run: `cd ui && bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/now.svelte.ts
git commit -m "feat(ui): shared 30s clock store for time-based badges"
```

---

### Task 5: Tri-state badge logic

**Files:**
- Modify: `ui/src/lib/components/critic-badge.ts`
- Test: `ui/src/lib/components/critic-badge.test.ts` (create)

- [ ] **Step 1: Write the failing unit test**

Create `ui/src/lib/components/critic-badge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addressRoundInfo } from "./critic-badge";
import type { ReviewVerdict } from "$lib/types";

const base: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  decision: "changes_requested",
  summary: "",
  body: "",
  findings: ["x"],
  addressRound: 0,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: 1_000_000,
};
const v = (p: Partial<ReviewVerdict>): ReviewVerdict => ({ ...base, ...p });

describe("addressRoundInfo", () => {
  it("returns null when no streak is in progress", () => {
    expect(addressRoundInfo(v({ addressRound: 0 }), 2_000_000)).toBeNull();
  });

  it("below the cap is an in-progress round", () => {
    expect(addressRoundInfo(v({ addressRound: 2 }), 2_000_000)).toEqual({
      round: 2,
      cap: 3,
      status: "round",
    });
  });

  it("at the cap but pending (within timeout) is the dimmed final round", () => {
    const r = addressRoundInfo(
      v({ addressRound: 3, finalRoundPending: true, updatedAt: 1_000_000 }),
      1_000_000 + 60_000, // 1 min later, well under 15 min
    );
    expect(r).toEqual({ round: 3, cap: 3, status: "final" });
  });

  it("at the cap, held (not pending) is a confirmed stall", () => {
    expect(
      addressRoundInfo(v({ addressRound: 3, finalRoundPending: false }), 2_000_000),
    ).toEqual({ round: 3, cap: 3, status: "stalled" });
  });

  it("a pending final round past its timeout escalates to stalled", () => {
    const r = addressRoundInfo(
      v({ addressRound: 3, finalRoundPending: true, updatedAt: 1_000_000 }),
      1_000_000 + 900_000 + 1, // just past 15 min
    );
    expect(r).toEqual({ round: 3, cap: 3, status: "stalled" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && bun run test critic-badge` (vitest name filter)
Expected: FAIL — current `addressRoundInfo` returns `{ stalled }`, takes one arg, and has no `status`.

- [ ] **Step 3: Rewrite `addressRoundInfo`**

Replace the `addressRoundInfo` function in `ui/src/lib/components/critic-badge.ts` (lines 17-29) with:

```ts
export type AddressStatus = "round" | "final" | "stalled";

/**
 * Auto-address streak state for the badge, or null when no streak is in progress.
 * The cap comes off the verdict (`addressCap`) — the server's live value — so the badge
 * math never drifts from a hardcoded mirror.
 *  - "round":   below the cap, agent addressing findings, more rounds left (blue).
 *  - "final":   cap-th steer just delivered (`finalRoundPending`), agent addressing the
 *               last allowed round (dimmed). Escalates to "stalled" after the verdict's
 *               `finalRoundTimeoutMs` if no re-review lands (agent abandoned it).
 *  - "stalled": cap reached and that final round already failed re-review, OR the pending
 *               final round timed out → needs a human (orange).
 * `now` is the current time (ms); pass a reactive clock so the timeout escalation is live.
 */
export function addressRoundInfo(
  v: ReviewVerdict | undefined,
  now: number,
): { round: number; cap: number; status: AddressStatus } | null {
  if (!v || v.addressRound <= 0 || v.findings.length === 0) return null;
  const cap = v.addressCap;
  const round = v.addressRound;
  if (round < cap) return { round, cap, status: "round" };
  // At/over the cap. A held round (not pending) is a confirmed stall.
  if (!v.finalRoundPending) return { round, cap, status: "stalled" };
  // Pending: `updatedAt` is the final-steer delivery time — putReview runs once per
  // review cycle, and the next putReview is the re-review that clears finalRoundPending,
  // so updatedAt stays frozen at delivery while pending. (If anything ever bumps updatedAt
  // mid-cycle, switch to an explicit finalRoundDeliveredAt field.)
  if (now - v.updatedAt > v.finalRoundTimeoutMs) return { round, cap, status: "stalled" };
  return { round, cap, status: "final" };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ui && bun run test critic-badge` (vitest name filter)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/critic-badge.ts ui/src/lib/components/critic-badge.test.ts
git commit -m "feat(critic): tri-state badge status (round/final/stalled)"
```

---

### Task 6: i18n keys (EN + DE)

**Files:**
- Modify: `ui/messages/en.json`
- Modify: `ui/messages/de.json`

- [ ] **Step 1: Add the EN keys**

In `ui/messages/en.json`, next to `criticbadge_stalled` (~line 320), add:

```json
  "criticbadge_final": "FINAL {round}/{cap}",
  "criticbadge_final_title": "Addressing the last allowed round — no more rounds after this.",
```

- [ ] **Step 2: Add the DE keys**

In `ui/messages/de.json`, at the matching location (~line 320), add:

```json
  "criticbadge_final": "FINALE {round}/{cap}",
  "criticbadge_final_title": "Bearbeitet die letzte erlaubte Runde — danach folgt keine weitere.",
```

- [ ] **Step 3: Verify catalog parity**

Run: `cd ui && bun run check:i18n`
Expected: PASS (identical, non-empty key sets across en/de).

- [ ] **Step 4: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json
git commit -m "feat(i18n): critic FINAL badge strings (en+de)"
```

---

### Task 7: Render the tri-state badge

**Files:**
- Modify: `ui/src/lib/components/CriticBadge.svelte`

- [ ] **Step 1: Wire the clock into the derived status**

In `ui/src/lib/components/CriticBadge.svelte` `<script>`, add the import and pass the clock:

```ts
  import { reviews } from "$lib/reviews.svelte";
  import { criticBadgeLabel, addressRoundInfo } from "./critic-badge";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const verdict = $derived(reviews.map[sessionId]);
  const label = $derived(criticBadgeLabel(verdict));
  const round = $derived(addressRoundInfo(verdict, clock.current));
```

- [ ] **Step 2: Replace the round render block with three branches**

Replace the `{#if round}` block (lines 23-37) with:

```svelte
{#if round}
  {#if round.status === "stalled"}
    <span
      class="critic-badge critic-stalled"
      title={m.criticbadge_stalled_title({ cap: round.cap })}
      >{m.criticbadge_stalled({ round: round.round, cap: round.cap })}</span
    >
  {:else if round.status === "final"}
    <span
      class="critic-badge critic-final"
      title={m.criticbadge_final_title()}
      >{m.criticbadge_final({ round: round.round, cap: round.cap })}</span
    >
  {:else}
    <span
      class="critic-badge critic-round"
      title={m.criticbadge_round_title({ round: round.round, cap: round.cap })}
      >{m.criticbadge_round({ round: round.round, cap: round.cap })}</span
    >
  {/if}
{/if}
```

- [ ] **Step 3: Add the dimmed `.critic-final` style**

In the `<style>` block, after `.critic-round { ... }` (~line 61), add:

```css
  /* final allowed round in flight: agent is addressing it — recessive vs. both the
     blue in-progress rounds and the orange confirmed stall. */
  .critic-final {
    border-color: var(--color-line);
    color: var(--color-faint);
  }
```

- [ ] **Step 4: Type-check + run UI tests**

Run: `cd ui && bun run check && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/CriticBadge.svelte
git commit -m "feat(critic): render dimmed FINAL badge for in-flight last round"
```

---

### Task 8: Full verification

- [ ] **Step 1: Root server checks**

Run: `bun run lint && bunx tsc --noEmit && bun test ./test`
Expected: PASS.

- [ ] **Step 2: UI checks**

Run: `cd ui && bun run check && bun run check:i18n && bun run test`
Expected: PASS.

- [ ] **Step 3: Confirm no other consumer of the old `addressRoundInfo` signature**

Run: `grep -rn "addressRoundInfo" ui/src`
Expected: only `critic-badge.ts` (definition + test) and `CriticBadge.svelte` (call with two args).

---

## Verification against the spec

- §1 server flag + constant → Task 1. §2 types → Tasks 1 (server) + 3 (UI). §3 persistence → Task 2. §4 UI status fn → Task 5. §5 render + clock → Tasks 4 + 7. §6 i18n → Task 6. §7 tests → Tasks 1, 2, 5. Full-suite gate → Task 8.
- Decisions honored: word `FINAL` (Task 6), 15-min timeout (`DEFAULT_FINAL_ROUND_TIMEOUT_MS`, Task 1), reuse `updatedAt` as delivery time (Task 5 comment), self-escalation after timeout (Task 5 logic + Task 4 clock).

## Unresolved questions

None.
