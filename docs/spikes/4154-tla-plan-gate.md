# Spike #4154: a TLA+ model of the plan-gate lifecycle

**Question.** Does a TLA+ model with restart as an action find real bugs in one of Shepherd's
implicit state machines, and is it worth doing for the next one (#2, drain claim)? The target came
from the ranking in
[lutke-senra-podcast-ai-coding-2026-11.md §5](../research/lutke-senra-podcast-ai-coding-2026-11.md).
The plan gate's state is split across `sessions.planPhase`, `plan_gates`, `reviewer_spawns` and the
in-memory `inflight` / `starting` / `cancelledHashes` / `planReleaseInFlight`.

## Decision: **GO** for #2 (drain claim)

TLC found **four confirmed bugs** in the plan gate. All four violate invariants the operator chose,
and each has a failing-test reproduction against the real `PlanGateService`. Three need a restart
or a narrow await window, which is exactly the class unit tests don't find. The fourth needs no
restart. A fifth trace was rejected against the code. Each candidate fix was modelled. With all
four, every property holds. Removing any one brings back its counterexample.

The cost was moderate. The spec is about 480 lines and the checks run in seconds. The real work was
reading every modelled code path at `await` granularity. That reading also caught one wrong
assumption in the plan before any model was run: an operator `mode: "go"` edit moves the approval
onto the operator's own revision by design (#3518), so `ApprovalMatchesReviewed` covers reviewer
approvals only.

## The model

[`docs/spec/plan-gate/`](../spec/plan-gate/README.md) contains the spec, two configs, the
action-to-code map, the abstractions, and `run-tlc.sh`. TLC v1.8.0 is pinned by sha256.

```sh
bash docs/spec/plan-gate/run-tlc.sh                    # code as-is: Invariant ApprovalMatchesReviewed is violated
bash docs/spec/plan-gate/run-tlc.sh PlanGateFixed.cfg  # all four fixes: no error, 1,715,670 distinct states
```

Each action is one synchronous run between two `await`s. `Restart` drops all in-memory state and
every in-progress call. The boot chain (`adoptOrphans` → `gcStaleReviewWorktrees`) then interleaves
with everything else, as it does in `src/index.ts`. Bounds: one session, `Plans = {P1, P2}`,
`MaxSpawns = 2`, `MaxRestarts = 1`, `MaxEdits = 2`. With the code as it is, that is 9.1M distinct
states.

## Invariants (operator-chosen)

| Property                  | Kind   | Statement                                                                                                                                               | Code as-is                |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `ExecApproved`            | action | Go / chat release → `executing` only with an approved gate. For Go, on the planHash snapshotted at Go start. PR auto-advance (#809) excluded by design. | holds                     |
| `ApprovalMatchesReviewed` | state  | A reviewer's approval is stamped on the hash of the text that reviewer read.                                                                            | fixed (CE-1, #4160)       |
| `NoStaleReviewer`         | state  | An approved gate plus a reviewer whose verdict is still pending means that reviewer is a re-review of a different plan.                                 | **violated** (CE-2)       |
| `RegateSticks`            | state  | `approvedAt` set but not approved means the session is `planning`.                                                                                      | **violated** (CE-3)       |
| `NoExecWhileRegated`      | action | No planning → executing step while the gate is re-gated.                                                                                                | holds                     |
| `NoLeakedSpawn`           | state  | Once boot recovery is done and nothing is mid-flight, every open spawn row with a live worktree is owned by `inflight`.                                 | **violated** (CE-2, CE-4) |
| `SingleReviewer`          | state  | Outside the boot window, at most one live reviewer that isn't being torn down.                                                                          | **violated** (CE-2)       |

## Counterexamples

Each trace below is the shortest TLC found with only that fix removed from `PlanGateFixed.cfg`.

### CE-1: an adopted orphan's approval lands on a plan nobody reviewed (confirmed, [#4160](https://github.com/erwins-enkel/shepherd/issues/4160))

`consider()` spawns a reviewer on P1 → the agent edits the plan to P2 → the reviewer writes
"approve" → restart → `adoptOrphans` → `buildAdoptedInflight` hashes the **current** plan (P2) →
`tick` writes `approved: true, planHash: P2`. For an auto session, the release follows.

- **Code:** `buildAdoptedInflight` uses `readPlan(s.worktreePath)`, while the reviewer was given the
  text captured in `consider()`. `livePlanHash` is set to the same hash, so the drift marker stays
  silent.
- **Fix (`adoptPlan`):** adopt with the hash the reviewer read. That text is already recorded as a
  plan revision in `begin()`.
- **Repro:** `test/plan-gate-tla-repro.test.ts` "CE-1".
- **Status:** fixed (#4160). The spawn row stores `reviewedPlanHash`; adoption takes the text from
  that revision and reaps the orphan when no revision holds it. The repro is now a plain `test`.

### CE-2: `consider()` races `adoptOrphans` at boot (confirmed, [#4161](https://github.com/erwins-enkel/shepherd/issues/4161))

A reviewer is running → restart → `adoptOrphans` passes its `inflight`/`starting` check and awaits
`buildAdoptedInflight` (`herdr.listAsync`) → a settle edge fires `consider()`, which passes the same
check → both `inflight.set` with no re-check. The outcomes, one per violated invariant:

- **Two live reviewers** (`SingleReviewer`).
- **The losing reviewer is never finalized**, and `gcStaleReviewWorktrees` may delete the worktree
  of the reviewer `begin()` is still launching (`NoLeakedSpawn`).
- **The adopted run approves while `consider()` is mid-`begin()`**, which then spawns a reviewer for
  the plan that was just approved (`NoStaleReviewer`).

- **Fix (`bootRace`):** `consider()` waits for the boot chain to finish. Re-checking `inflight`
  before each `set` is not enough, because gc can still reap a launching worktree.
- **Repro:** "CE-2".

### CE-3: Go or a chat reply during a re-review's findings steer leaves the session executing on a withdrawn approval (confirmed, [#4162](https://github.com/erwins-enkel/shepherd/issues/4162))

Approved on P1 while still planning → the agent edits to P2 → the operator forces a re-review
(#2224) → "changes" → `applyChangesRequested` withdraws the approval early **only when executing**,
so the gate stays `approved` across `await steerFindings` → the operator replies in chat (or a
Go lands) → `executing` → the tail `putPlanGate` writes `approved: false`.

- **Result:** the session is executing on a withdrawn approval. The agent got both "implement" and
  "revise these findings", and nothing re-gates it.
- **Fix (`tailPut`):** when previously approved, persist the revoking verdict before the steer in
  every phase.
- **Repro:** "CE-3".

### CE-4: a finishing finalize drops a newer run's `inflight` entry (confirmed, no restart, [#4163](https://github.com/erwins-enkel/shepherd/issues/4163))

A finalize is parked in `captureRunUsage` / `herdr.stop` → a PR appears and
`advanceToExecutionOnPr` + `reapReviewer` drop its entry → the operator forces a re-review of the
edited approved plan, which claims `inflight` → the old `tick()` reaches its `finally` →
`dropInflight` deletes by **session id** → the new reviewer runs on, but its verdict is never read
and its row is never completed.

- **Fix (`dropOwn`):** delete only `inflight.get(id) === f`.
- **Repro:** "CE-4".

### Rejected: a cancelled reviewer counted as a second live reviewer

The first `SingleReviewer` trace was an operator plan edit that cancels a run while a forced
`consider()` spawns a new one. The cancelled reviewer's row was still open while `cancel()` awaited
`captureRunUsage` / `reapRun`. It is rejected against `ReviewerRuns.cancel`, which has already
called `dropInflight` + `markCancelled` synchronously before those awaits. That reviewer is being
torn down and owns no state. The property was meant to be about live, un-reaped reviewers, so the
model now excludes rows that a cancel, finalize or orphan reap is tearing down (`TearingDown`).

### Spec bug (not a counterexample)

The first `TypeOK` run overflowed the edit bound, because `EditLand` didn't re-check `MaxEdits`
after an agent edit raced the request. This was fixed in the spec.

## Verification

- `bash docs/spec/plan-gate/run-tlc.sh` reports `ApprovalMatchesReviewed` violated. Each other
  invariant, checked on its own against the code as-is, gives the traces above. `ExecApproved` and
  `NoExecWhileRegated` hold across all 9,095,897 distinct states.
- `bash docs/spec/plan-gate/run-tlc.sh PlanGateFixed.cfg` finds no error in 1,715,670 distinct
  states. Removing any single fix brings back exactly its counterexample. At larger bounds
  (`MaxSpawns = 3`, `MaxRestarts = 2`), the fixed model also finds no error: 123,569,249 distinct
  states, depth 54, 3 min 3 s on 32 workers.
- `bun test ./test/plan-gate-tla-repro.test.ts` passes 4 `test.failing`. As plain `test`, each fails
  on its final invariant assertion, and not earlier in the setup.

## Recommendations

1. **Next model: #2, drain claim + epic landing.** Use the same discipline: the operator writes the
   invariants, a trace is confirmed or rejected against named code, and each fix is checked as a
   model flag. Its suspected bug (`retainClaimOnArchive` is memory-only, so a restart between settle
   and archive drops the claim) has the same shape as CE-1 and CE-2.
2. **Fix order:** CE-4 and CE-3 are small and local. CE-1 needs the reviewed hash persisted. CE-2
   needs a boot-readiness barrier.
3. **Don't extract `State`/`transition()` yet** (issue step 5). The four fixes are local guards. Once
   they land, the cheaper keep-it-honest step is a CI job that runs `PlanGateFixed.cfg` (seconds),
   with `Fixes` removed from the spec once the code matches.
4. **CE-2 and CE-4 patterns probably exist in `ReviewService`**, which shares `ReviewerRuns`, the
   adopt-at-boot logic and drop-by-session-id. Check them when fixing #4161 and #4163.
