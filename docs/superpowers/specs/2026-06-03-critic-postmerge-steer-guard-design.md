# Spec: guard critic auto-address steer against a merged/closed PR

Date: 2026-06-03
Status: approved, ready for implementation plan
Area: server (`src/review.ts`), tests (`test/review.test.ts`)

## Problem

An in-flight critic can steer findings into the task agent **after that agent's PR
has already merged**, telling it to "commit & push so CI and the critic re-run" on a
branch whose PR is closed/deleted — producing churn against a dead branch.

Confirmed by reading `src/review.ts`:

- The only merged-PR guard is in `consider()` (`review.ts:141`):
  `if (git.state !== "open" || ...) return;`. It blocks spawning a **new** critic on a
  merged PR.
- Once a critic is `inflight`, the delivery chain `tick()` → `finalize()` →
  `runAutoAddress()` → `autoAddress()` steer **never rechecks live PR state**. The
  `InFlight` record snapshots `headSha`/`prNumber` at spawn (`review.ts:72-85`,
  `255-267`) and nothing reconsults the forge before steering.

This is **not a corner case**. Critic spawn and PR merge are both gated on CI-green:
the same green that spawns the critic is the green light to merge. Any promptly-merged
green PR has an in-flight critic that finalizes (15s tick) and steers — and because
merge-detection is a 120s poll, the steer routinely beats the merge being noticed.

## Root cause (reframed)

Not "merge causes chaos." The cause is: **the in-flight critic delivers findings
without re-confirming the PR is still open at finalize time** — the last moment before
the steer. The spawn-time guard does not protect the delivery path, and the spawn and
merge co-trigger on CI-green so they race by construction.

## Fix

Re-fetch authoritative live PR state in `finalize()` and, when the PR is no longer
`"open"`, treat the whole verdict as **moot** — emit none of its outward effects.

### Scope — moot run

> **History:** originally shipped "surgical" (steer-only) per an explicit scope call;
> widened to the moot run below in response to the PR #281 critic review, which flagged
> that posting a `REQUEST_CHANGES` review and recording a `critic` learnings signal on an
> already-merged PR is itself confusing/noise.

When the PR is not open at finalize, **all three** outward effects are suppressed: the
steer, `postReview()`, **and** the `critic` learnings signal. Still run regardless of
state: `putReview()` (verdict persisted for UI/dedup), `onChange()`, and the
worktree/terminal reap (the `finally`). A merged/closed PR's critic run leaves no trace
on the world beyond the local verdict row.

### Mechanics

1. **Carry the branch.** Add `branch: string` to `InFlight`, captured from
   `session.branch` in `begin()`. `prStatus()` keys on the head branch, and `InFlight`
   currently stores only `prNumber`.

2. **`runAutoAddress()` stays synchronous** (`: number`). `finalize()` awaits the single
   `prStatus()` call directly and calls `runAutoAddress()` un-awaited inside the open
   gate. (Reaching `runAutoAddress()` already implies the PR is open, so it does no
   recheck of its own.)

3. **Single live recheck in `finalize()`.** At the top of the real-verdict (`else`)
   branch, call `resolveForge(f.repoPath)?.prStatus(f.branch)` once and compute
   `open = state === "open"`. Gate `postReview()`, `runAutoAddress()`, and the `critic`
   `addSignal()` together behind `if (open && forge)`. One forge call per finalized real
   verdict — `finalize()` already does forge I/O (`postReview`, `fetchAuthorNotes`), so
   this is consistent.

4. **Not open ⇒ inert.** The whole open-gated block is skipped; `addressRound` keeps its
   `buildVerdict` default (`0`) and no review/steer/signal is emitted.

5. **Fail-closed.** If `prStatus()` throws or the forge can't be resolved (state can't be
   confirmed open), stay fully inert. Rationale: a missed review/steer is recoverable
   (next push re-triggers; a human can send manually); acting on a dead PR is not. Log
   the skip (`console.warn`), consistent with the file's other best-effort forge warnings.

### Whole-class coverage

The guard checks `state === "open"`, so every non-open state — **merged, closed, and
`none`** (e.g. a branch deleted on merge) — is inert, not just the literal merged case
named in the bug.

### Deliberately NOT in scope (YAGNI)

- **Event-driven abort-on-merge.** A `session:git` handler that aborts an in-flight
  critic when its PR leaves `"open"` would save wasted critic compute, but **cannot
  close the race alone**: the 15s finalize tick can fire before the 120s merge-detection
  poll runs. The finalize-time recheck is the authoritative fix; early abort is a
  separable optimization, omitted here.

## Race / concurrency safety

The `await prStatus()` sits inside the `f.finalizing = true` window. Overlapping ticks
already `continue` past a `finalizing` entry (`tick()`, `review.ts:308`), so no new
double-finalize race is introduced, and no dedupe-guard/slot-claim is straddled (the
inflight slot is claimed for the whole of `finalize`). `finalize()` already performs
forge I/O (`postReview`, `fetchAuthorNotes`) on this same tick, so the added
`prStatus()` call introduces no new class of blocking and is not on a request handler.

## No UI / i18n impact

Server-only. `steerText` / `reviewPrompt` remain English (agent-facing, never i18n'd).
The verdict payload shape is unchanged; on a non-open PR the verdict is still persisted
but carries no `url` and `addressRound` stays `0`. No locale-catalog or Svelte changes.

## Test plan (`test/review.test.ts`, `test/signal-capture.test.ts`)

Thread an optional PR state into the test forge: extend `fakeForge` / `makeDeps` so a
test can make `prStatus` resolve a non-open state (default stays `OPEN_GREEN`, so every
existing open-path test passes unchanged).

Cases:

1. **Merged at finalize ⇒ fully inert.** `autoAddressEnabled`, findings present,
   `prStatus → { ...OPEN_GREEN, state: "merged" }`. Assert: `steers` empty;
   `rec.event === undefined` (postReview **not** fired); no `critic` signal; verdict still
   persisted (`decision === "changes_requested"`); `addressRound === 0`.
2. **`prStatus` throws ⇒ fully inert (fail-closed).** Assert `steers` empty and
   `rec.event === undefined`; tick does not reject.
3. **Closed (not merged) ⇒ fully inert.** `state: "closed"` — assert `steers` empty and
   `rec.event === undefined`; proves whole-class coverage.
4. **Open path unchanged (regression guard).** Covered by the existing default-open
   tests: "consider → tick: posts request-changes…" (review + signal fire) and "round cap
   reached…" (review + signal fire, no steer). `signal-capture.test.ts` swaps its
   `resolveForge: () => null` for an open fake forge so the `critic`-signal path stays
   genuinely exercised under the new gate.

Existing suite must remain green (the default-open forge keeps open-path tests intact).

## Verification

- `bun run lint` (root)
- `bun test ./test` (root server tests; includes `test/review.test.ts`)
- `bunx tsc --noEmit` (root strict tsc)
