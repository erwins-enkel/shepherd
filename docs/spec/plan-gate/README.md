# Plan-gate TLA+ model

A TLA+ model of one session's plan-gate lifecycle, including **server restart as an action**. It is
the pilot from [#4154](https://github.com/erwins-enkel/shepherd/issues/4154). Results,
counterexamples and the go/no-go for the next model are in
[docs/spikes/4154-tla-plan-gate.md](../../spikes/4154-tla-plan-gate.md).

| File                | What                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `PlanGate.tla`      | The spec: state, actions, operator-chosen properties                        |
| `PlanGate.cfg`      | The code as it is (`Fixes = {}`): TLC reports a counterexample              |
| `PlanGateFixed.cfg` | All candidate fixes modelled: TLC checks every property with no error       |
| `run-tlc.sh`        | Downloads the pinned, sha256-verified `tla2tools.jar` (v1.8.0) and runs TLC |

## Run

Needs Java 11 or newer. The first run downloads the jar into `~/.cache/tla/`.

```sh
bash docs/spec/plan-gate/run-tlc.sh                    # code as-is → "Invariant ApprovalMatchesReviewed is violated"
bash docs/spec/plan-gate/run-tlc.sh PlanGateFixed.cfg  # all fixes → "No error has been found", ~1.7M distinct states, seconds
```

To see one counterexample, remove its fix from `Fixes` in `PlanGateFixed.cfg` and re-run. Each fix
maps to one counterexample (see the results doc). TLC prints the trace as a sequence of states, with
each state labelled by the action that produced it.

## How the model maps to the code

**Granularity:** one action is one synchronous run of the single Bun event loop between two
`await`s. Every `await` in a modelled path is a pc value where any other action may interleave.

| Action                                                                   | Code                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConsiderStart` / `ConsiderRecheck` / `ConsiderSpawn` / `ConsiderLaunch` | `PlanGateService.consider()` guards + `starting` claim + `skipForPlanHash`; `begin()`'s single `starting` re-check (after `createDetached`); `recordReviewerSpawn` after `await resolveAuxPatch` (no second re-check); `herdr.start` → `inflight.set` |
| `ReviewerVerdict`                                                        | the reviewer writes `.shepherd-plan-review.json` ("error" = timeout / unparseable)                                                                                                                                                                    |
| `TickFinalize`                                                           | `tick()` claim (`finalizing`) + `finalize()` → `buildGate` + sync head of `applyApproved` / `applyChangesRequested` / `applyError`                                                                                                                    |
| `FinalizeAfterRelease` / `FinalizeTailPut`                               | `applyApproved`'s `await release`; `applyChangesRequested`'s tail `putPlanGate` after the steer                                                                                                                                                       |
| `FinalizeUsage` / `FinalizeReap`                                         | `captureRunUsage` → `completeReviewerSpawn`; `finally` worktree remove + `tick()`'s `dropInflight`                                                                                                                                                    |
| `GoStart` / `GoFinish`                                                   | `SessionService.releasePlanGate()` up to `await resumeAndReply`; the re-check + `#enterExecution`                                                                                                                                                     |
| `ChatRelease`                                                            | `SessionService.releasePlanOnOperatorReply()`                                                                                                                                                                                                         |
| `PrAdvance`                                                              | `advanceToExecutionOnPr()` + `planGate.reapReviewer()` (`src/index.ts`)                                                                                                                                                                               |
| `EditStart` / `EditCancelDone` / `EditLand`                              | `handleSessionPlanEdits`: `planEditLanding` + `cancel()`; its usage/reap awaits; `applyPlanEdit` (`gateAfterPlanEdit`) + `deliverPlanEdit` (Go or `regateForPlanEdit`)                                                                                |
| `AgentEditsPlan`, `PrOpens`                                              | the planning agent writes `.shepherd-plan.md`; the session gets a PR                                                                                                                                                                                  |
| `Restart`                                                                | process death: clears `inflight`, `starting`, `cancelledHashes`, `planReleaseInFlight` and every in-progress call                                                                                                                                     |
| `AdoptVisit` / `AdoptReap` / `AdoptSet` / `BootGc`                       | `adoptOrphans()` loop body (`orphanDisposition`), `reapOrphanSpawn`, `buildAdoptedInflight` → `inflight.set`; `gcStaleReviewWorktrees()`                                                                                                              |

## Abstractions (what the model leaves out)

- **One session.** `inflight`, `starting` and `cancelledHashes` are keyed per session, and nothing
  else couples sessions.
- **`begin()`'s awaits are merged into two steps:** `fetchIssueBody` + `createDetached` up to the single
  `starting` re-check, and `resolveAuxPatch` up to `recordReviewerSpawn`. `herdr.start` is a third.
- **One `consider()` at a time.** In the code, a second `consider()` can start once `reapReviewer`
  has cleared `starting` mid-`begin()`. The model doesn't explore that.
- **Plan hashes are the plan texts** (`Plans = {P1, P2}`). Round, cap, `dismissed`,
  `finalRoundPending`, answered questions, `livePlanHash` and `noteLivePlan` are left out because no
  checked property reads them. `resume()`/`dismiss()` only touch those fields.
- **Not modelled:** capacity/quota gates, provider handoff holds, build queue, effort switch, goal
  arming, operator hold, archive/`forget()`, `planPhase = null`, `sweepCompletedCodexPlans`, and
  spawn failure paths. A refused release or a failed steer is modelled as a nondeterministic no-op
  where it gates a step.
- **A refused `cancel()`** (mid-spawn or finalizing) refuses the plan edit. The model doesn't
  explore the 3 s poll after which a cancel can still succeed. That path is equivalent to an edit
  that lands after the finalize, which the model does cover.
- **Safety only**, no liveness or fairness. Bounds: `MaxSpawns = 2`, `MaxRestarts = 1`,
  `MaxEdits = 2` (the fixed model also passes at `MaxSpawns = 3`, `MaxRestarts = 2`; see the results
  doc).
