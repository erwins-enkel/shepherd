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

Re-fetch authoritative live PR state at the **last gate before the steer**
(`runAutoAddress()`), and skip the steer when the PR is no longer `"open"`.

### Scope — surgical (steer only)

Only the auto-address steer is suppressed. **Unchanged:** `postReview()` (a merged PR
still gets its critic review posted), `putReview()` (verdict still persisted), and the
`critic` learnings signal. The chaos source is the steer; that is the only behavior
that changes.

### Mechanics

1. **Carry the branch.** Add `branch: string` to `InFlight`, captured from
   `session.branch` in `begin()`. `prStatus()` keys on the head branch, and `InFlight`
   currently stores only `prNumber`.

2. **Make `runAutoAddress()` async** (`Promise<number>`); `finalize()` awaits it:
   `verdict.addressRound = await this.runAutoAddress(f, verdict);`.

3. **Lazy live recheck.** Inside `runAutoAddress()`, *after* the existing guards
   (findings non-empty → `autoAddressEnabled` → `priorRound < cap`) and **only** when
   about to steer, call `resolveForge(f.repoPath)?.prStatus(f.branch)`. Steer only if
   live `state === "open"`. The laziness means clean verdicts, disabled-loop repos, and
   at-cap streaks make **zero** new forge calls.

4. **Not open ⇒ hold the round.** Skip the steer and return `f.priorRound` (no advance,
   no reset) — identical to the existing "steer didn't land" semantics, so the badge is
   coherent and a later push could retry.

5. **Fail-closed.** If `prStatus()` throws, or the forge can't be resolved (state can't
   be confirmed open), skip the steer and hold the round. Rationale: the steer is
   recoverable (next push re-triggers; a human can send manually); the chaos is not.
   Log the skip (`console.warn`), consistent with the file's other best-effort forge
   warnings.

### Whole-class coverage

The guard checks `state !== "open"`, covering **merged, closed, and `none`** (e.g. a
branch deleted on merge) — not just the literal merged case named in the bug.

### Deliberately NOT in scope (YAGNI)

- **Event-driven abort-on-merge.** A `session:git` handler that aborts an in-flight
  critic when its PR leaves `"open"` would save wasted critic compute, but **cannot
  close the race alone**: the 15s finalize tick can fire the steer before the 120s
  merge-detection poll runs. The finalize-time recheck is the authoritative fix; early
  abort is a separable optimization, omitted here.
- Suppressing `postReview` / signal on a merged PR (rejected: surgical scope).

## Race / concurrency safety

The new `await` sits inside the `f.finalizing = true` window. Overlapping ticks already
`continue` past a `finalizing` entry (`tick()`, `review.ts:306`), so no new
double-finalize race is introduced, and no dedupe-guard/slot-claim is straddled (the
inflight slot is claimed for the whole of `finalize`). `finalize()` already performs
forge I/O (`postReview`, `fetchAuthorNotes`) on this same tick, so the added
`prStatus()` call introduces no new class of blocking and is not on a request handler.

## No UI / i18n impact

Server-only. `steerText` / `reviewPrompt` remain English (agent-facing, never i18n'd).
The verdict payload shape is unchanged; `addressRound` simply does not advance when the
PR is no longer open. No locale-catalog or Svelte changes.

## Test plan (`test/review.test.ts`)

Thread an optional PR state into the test forge: extend `fakeForge` / `makeDeps` so a
test can make `prStatus` resolve a non-open state (default stays `OPEN_GREEN`, so every
existing steer test passes unchanged).

New cases:

1. **Merged at finalize ⇒ no steer (surgical).** `autoAddressEnabled`, findings
   present, `prStatus → { ...OPEN_GREEN, state: "merged" }`. Assert: `steers` empty;
   `addressRound` held (not advanced); `rec.event === "REQUEST_CHANGES"` (postReview
   still fired); verdict persisted.
2. **Still open ⇒ steers as before.** `prStatus → OPEN_GREEN`. Assert one steer,
   `addressRound` advances (guards the default path).
3. **`prStatus` throws ⇒ no steer, round held (fail-closed).**
4. **Closed (not merged) ⇒ no steer.** `state: "closed"` — proves whole-class coverage.

Existing suite must remain green (the default-open forge keeps steer tests intact).

## Verification

- `bun run lint` (root)
- `bun test ./test` (root server tests; includes `test/review.test.ts`)
- `bunx tsc --noEmit` (root strict tsc)
