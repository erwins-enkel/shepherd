# Tri-state critic badge: distinguish "final round in flight" from "stalled"

**Date:** 2026-06-03
**Status:** Approved design, pre-implementation

## Problem

When the auto-review (critic) address loop hits its round cap (default 3), the
session's critic badge immediately flips to orange `STALLED 3/3`. But that flip
happens **at the instant the 3rd (last allowed) steer is delivered** — i.e. right
when the task agent *starts* addressing that final round. The feedback **is** fed
back and processed; the loop simply won't spawn a 4th round. So the orange badge
fires one review too early: it screams "needs a human" while the agent is still
working the last allowed round.

### Root cause

The UI computes stalled (`ui/src/lib/components/critic-badge.ts:28`) as:

```
stalled = addressRound >= cap && findings.length > 0
```

This single expression conflates two genuinely distinct states:

| State | How it arises (`runAutoAddress`, `src/review.ts:393-416`) | Today's badge |
| --- | --- | --- |
| **Final round in flight** — cap-th steer just delivered, agent addressing it, outcome unknown | round *advanced into* cap (e.g. `priorRound 2 → 3`, delivered) | orange (wrong) |
| **Genuinely stalled** — final round already failed, loop holds with no steer | round *held at* cap (`priorRound 3 → 3`, `line 403`) | orange (right) |

The server knows which case it is (advanced vs. held) but never tells the UI, so
the UI can't draw them apart from a single verdict snapshot. The fix is a new
verdict field, which also keeps us compliant with the project rule against the UI
mirroring server-only state.

## Design

Tri-state escalation ladder for the badge:

```
ROUND 1/3   (blue)    rounds remaining, agent addressing findings
ROUND 2/3   (blue)
FINAL 3/3   (dimmed)   last allowed round delivered, agent addressing it
STALLED 3/3 (orange)   confirmed stuck (final round failed, OR abandoned) — needs a human
```

Orange now means exactly "we exhausted the rounds AND the last one didn't clear
it" (or the agent abandoned it). The agent is never shown as stalled while it's
mid-processing a delivered round.

### 1. Server — `src/review.ts`

Add a constant near `DEFAULT_CAP`:

```ts
const DEFAULT_FINAL_ROUND_TIMEOUT_MS = 15 * 60_000; // abandoned final round → orange
```

In `finalize()`, after `verdict.addressRound = this.runAutoAddress(f, verdict)`,
set the new flag:

```ts
verdict.finalRoundPending =
  verdict.findings.length > 0 &&
  verdict.addressRound >= this.cap &&
  verdict.addressRound > f.priorRound; // advanced INTO cap = steer just delivered
```

Behavior across paths:

- **Advanced into cap** (e.g. `2 → 3`, delivered): `pending = true` → dimmed FINAL.
- **Held at cap** (`3 → 3`, no steer, `line 403`): `addressRound === priorRound`,
  not `>`, so `pending = false` → orange (confirmed stall).
- **Error verdict** (`line 333-334`, `addressRound = priorRound`): not advanced →
  `pending = false`. Error streaks keep their own `errorRound` stall signal.
- **Clean** (`findings.length === 0`): `addressRound = 0` → `pending = false`.
- **Any cap**, incl. `cap = 1`: first findings → deliver → `0 → 1`, `1 >= 1`,
  `1 > 0` → `pending = true`. One dimmed final round even at cap 1.
- **Undelivered steer at cap-1** (dead pane): `runAutoAddress` returns `priorRound`
  unchanged, so round never reaches cap → stays blue `ROUND`; the dead pane is
  caught by the independent activity-stall poller.

### 2. Types — `src/types.ts` + `ui/src/lib/types.ts`

Add to `ReviewVerdict`:

```ts
finalRoundPending: boolean;   // cap-th steer delivered, no re-review yet → dimmed FINAL
finalRoundTimeoutMs: number;  // live abandonment-timeout, surfaced so UI never hardcodes it
```

`finalRoundTimeoutMs` follows the `addressCap` precedent: the UI reads the live
server value off the payload instead of mirroring a constant that could drift.

### 3. Persistence — `src/store.ts`

- New column: `finalRoundPending INTEGER NOT NULL DEFAULT 0` (0/1). Persisted so a
  page reload restores the correct badge state. Read/write in `putReview` /
  `getReview` alongside `addressRound`.
- `finalRoundTimeoutMs` is **not** stored. It is a current-config constant, only
  meaningful while pending, and always wants the live value — so it is injected at
  the read/serialization boundary from the review engine's constant, avoiding a
  migration for a constant.

### 4. UI badge state — `ui/src/lib/components/critic-badge.ts`

`addressRoundInfo` returns a discriminated status instead of a bare `stalled`
boolean. `now` is the current time from a reactive clock (see §5):

```ts
type AddressStatus = "round" | "final" | "stalled";

export function addressRoundInfo(
  v: ReviewVerdict | undefined,
  now: number,
): { round: number; cap: number; status: AddressStatus } | null {
  if (!v || v.addressRound <= 0 || v.findings.length === 0) return null;
  const cap = v.addressCap;
  const round = v.addressRound;
  if (round < cap) return { round, cap, status: "round" };
  // At/over cap:
  if (!v.finalRoundPending) return { round, cap, status: "stalled" }; // failed re-review
  // updatedAt == final-steer delivery time: putReview runs once per review cycle,
  // and the next putReview is the re-review that clears `finalRoundPending`, so
  // updatedAt is frozen at delivery while pending. If anything ever bumps updatedAt
  // mid-cycle, promote to an explicit finalRoundDeliveredAt field.
  if (now - v.updatedAt > v.finalRoundTimeoutMs) return { round, cap, status: "stalled" }; // abandoned
  return { round, cap, status: "final" };
}
```

### 5. Render — `ui/src/lib/components/CriticBadge.svelte`

Three render branches keyed off `status`:

- `round` → existing blue `.critic-round`, text `criticbadge_round`/current.
- `final` → new `.critic-final`, dimmed muted token, normal weight, text
  `criticbadge_final` ("FINAL {round}/{cap}"), tooltip `criticbadge_final_title`.
- `stalled` → existing orange `.critic-stalled`, text `criticbadge_stalled`.

`.critic-final` uses a muted color token (e.g. `var(--color-muted)` / subdued
border) — visibly recessive vs. both blue and orange.

**Reactive clock:** the timeout branch needs `now` to advance so an abandoned
final round flips to orange without a server round-trip. Reuse an existing shared
`now`/tick store if the app has one (used for relative timestamps); otherwise add
a single shared store backed by a 30s `setInterval`. Do **not** create a
per-badge interval.

### 6. i18n — `ui/messages/en.json` + `ui/messages/de.json`

Add (both catalogs, snake_case, component-prefixed):

- `criticbadge_final` — EN `"FINAL {round}/{cap}"`, DE e.g. `"FINALE {round}/{cap}"`.
- `criticbadge_final_title` — EN: "Addressing the last allowed round — no more
  rounds after this." DE equivalent.

Catalog parity gate (`cd ui && bun run check:i18n`) must pass.

### 7. Tests

- **`src/review` test:** `finalRoundPending` is `true` when a steer advances the
  round into the cap; `false` on held-at-cap, error verdict, and clean verdict.
  Cover `cap = 1`.
- **`ui critic-badge.ts` unit:** all four outcomes of `addressRoundInfo` —
  `round` (below cap), `final` (pending, within timeout), `stalled` via failed
  re-review (`!pending`), `stalled` via abandonment (pending, `now - updatedAt >
  timeout`). Include the timeout boundary.

## Decisions

- **Badge word:** `FINAL`.
- **Abandonment timeout:** 15 min (`DEFAULT_FINAL_ROUND_TIMEOUT_MS`).
- **Delivery timestamp:** reuse `verdict.updatedAt` (documented dependency); no new
  field unless something bumps `updatedAt` mid-cycle.
- **Escalation model:** dimmed FINAL self-escalates to orange after the timeout
  (chosen over relying solely on the 8-min activity-stall poller), so the critic
  badge itself always reaches "needs a human".

## Open questions

None outstanding.
