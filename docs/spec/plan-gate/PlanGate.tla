------------------------------ MODULE PlanGate ------------------------------
(***************************************************************************)
(* The plan-gate lifecycle of ONE Shepherd session (#4154).                *)
(*                                                                         *)
(* Granularity: one action = one synchronous run of the single Bun event   *)
(* loop between two `await`s. Every await in a modelled code path is a     *)
(* step boundary (a pc value) where any other action may interleave.       *)
(*                                                                         *)
(* Persistent state (survives Restart): `sessions.planPhase`, `plan_gates`,*)
(* `reviewer_spawns`, the plan file, reviewer worktrees + verdict files    *)
(* (reviewer panes live in herdr, a separate process).                     *)
(* In-memory state (dropped by Restart): PlanGateService `inflight`,       *)
(* `starting`, `cancelledHashes`; SessionService `planReleaseInFlight`;    *)
(* and every in-progress async call (the pc variables).                    *)
(*                                                                         *)
(* See README.md for the action <-> code map and what is abstracted away.  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Plans,        \* plan texts; a plan's hash is the text itself
    NoPlan,       \* sentinel: no plan / no hash
    MaxSpawns,    \* reviewer_spawns rows (bounds consider/begin)
    MaxRestarts,  \* server restarts
    MaxEdits,     \* plan-file edits (agent + operator)
    Fixes         \* candidate fixes to model (subset of FixNames); {} = the code as it is

\* Candidate fixes for the confirmed counterexamples (docs/spikes/4154-tla-plan-gate.md):
\*  "adoptPlan" - adoptOrphans takes the hash the reviewer read, not the current plan's
\*  "bootRace"  - consider() refuses until the boot chain (adoptOrphans -> gc) has finished
\*  "tailPut"   - applyChangesRequested withdraws a prior approval BEFORE its steer await in every
\*                phase, not only when executing
\*  "dropOwn"   - finalize's dropInflight deletes the entry only if it is still its own run
FixNames == {"adoptPlan", "bootRace", "tailPut", "dropOwn"}
ASSUME Fixes \subseteq FixNames

Spawn == 1..MaxSpawns
Verdicts == {"pending", "approved", "changes", "error"}

NoGate == [exists |-> FALSE, dec |-> "none", approved |-> FALSE, hash |-> NoPlan,
           approvedAt |-> FALSE, upd |-> 0, by |-> "none", src |-> 0]
NoSpawn == [st |-> "none", wt |-> FALSE, at |-> 0, rev |-> NoPlan, verdict |-> "pending"]
NoInflight == [on |-> FALSE, sp |-> 0, hash |-> NoPlan, fin |-> FALSE]

VARIABLES
    \* session row + world
    phase,      \* sessions.planPhase: "planning" | "executing"
    via,        \* ghost: how the session last entered "executing"
    livePlan,   \* .shepherd-plan.md in the session worktree
    edits,      \* plan-file edits so far (bound)
    prOpen,     \* the session has a PR (drives advanceToExecutionOnPr)
    auto,       \* auto/autopilot session: applyApproved releases on its own
    \* persistent store
    gate,       \* plan_gates row (NoGate when absent)
    spawns,     \* reviewer_spawns rows + their worktree + verdict file
    nSp,        \* rows allocated
    clock,      \* logical clock for spawnedAt / updatedAt
    \* PlanGateService memory
    inflight, starting, cancelled,
    \* consider() -> begin() in progress
    cpc, cPlan, cForce, cSp,
    \* tick() -> finalize() in progress
    fpc, fSp, fGate,
    \* releasePlanGate() in progress (planReleaseInFlight)
    gpc, gHash,
    \* POST /plan-edits in progress
    epc, eMode, eBase, eSp,
    \* boot chain: adoptOrphans() -> gcStaleReviewWorktrees()
    boot, aTodo, apc, aSp, aPlan, restarts

sessVars  == <<phase, via, livePlan, edits, prOpen, auto>>
storeVars == <<gate, spawns, nSp, clock>>
memVars   == <<inflight, starting, cancelled>>
consVars  == <<cpc, cPlan, cForce, cSp>>
finVars   == <<fpc, fSp, fGate>>
goVars    == <<gpc, gHash>>
editVars  == <<epc, eMode, eBase, eSp>>
bootVars  == <<boot, aTodo, apc, aSp, aPlan, restarts>>
vars == <<sessVars, storeVars, memVars, consVars, finVars, goVars, editVars, bootVars>>

Max(S) == CHOOSE x \in S : \A y \in S : x >= y

GateT == [exists : BOOLEAN, dec : {"none", "approved", "changes", "error"},
          approved : BOOLEAN, hash : Plans \cup {NoPlan}, approvedAt : BOOLEAN,
          upd : Nat, by : {"none", "reviewer", "operator"}, src : 0..MaxSpawns]

TypeOK ==
    /\ phase \in {"planning", "executing"}
    /\ via \in {"none", "go", "chat", "pr"}
    /\ livePlan \in Plans
    /\ edits \in 0..MaxEdits
    /\ prOpen \in BOOLEAN /\ auto \in BOOLEAN
    /\ gate \in GateT
    /\ spawns \in [Spawn -> [st : {"none", "open", "done"}, wt : BOOLEAN, at : Nat,
                             rev : Plans \cup {NoPlan}, verdict : Verdicts]]
    /\ nSp \in 0..MaxSpawns /\ clock \in Nat
    /\ inflight \in [on : BOOLEAN, sp : 0..MaxSpawns, hash : Plans \cup {NoPlan}, fin : BOOLEAN]
    /\ starting \in BOOLEAN /\ cancelled \in Plans \cup {NoPlan}
    /\ cpc \in {"idle", "begin", "aux", "launch"}
    /\ fpc \in {"idle", "release", "steer", "usage", "reap"} /\ fGate \in GateT
    /\ gpc \in {"idle", "steer"}
    /\ epc \in {"idle", "cancel", "land"} /\ eMode \in {"resubmit", "go"}
    /\ boot \in {"adopt", "done"} /\ apc \in {"idle", "reap", "adopt"}
    /\ aTodo \subseteq Spawn /\ restarts \in 0..MaxRestarts

Init ==
    /\ phase = "planning" /\ via = "none"
    /\ livePlan = CHOOSE p \in Plans : TRUE
    /\ edits = 0 /\ prOpen = FALSE /\ auto \in BOOLEAN
    /\ gate = NoGate /\ spawns = [s \in Spawn |-> NoSpawn] /\ nSp = 0 /\ clock = 0
    /\ inflight = NoInflight /\ starting = FALSE /\ cancelled = NoPlan
    /\ cpc = "idle" /\ cPlan = NoPlan /\ cForce = FALSE /\ cSp = 0
    /\ fpc = "idle" /\ fSp = 0 /\ fGate = NoGate
    /\ gpc = "idle" /\ gHash = NoPlan
    /\ epc = "idle" /\ eMode = "resubmit" /\ eBase = NoPlan /\ eSp = 0
    /\ boot = "done" /\ aTodo = {} /\ apc = "idle" /\ aSp = 0 /\ aPlan = NoPlan
    /\ restarts = 0

-----------------------------------------------------------------------------
(* Helpers mirroring code predicates *)

\* PlanGateService.reapReviewer: clear `starting`, stop + remove an in-flight run (row NOT completed).
ReapReviewer ==
    /\ starting' = FALSE
    /\ IF inflight.on
         THEN /\ spawns' = [spawns EXCEPT ![inflight.sp].wt = FALSE]
              /\ inflight' = NoInflight
         ELSE UNCHANGED <<spawns, inflight>>

\* PlanGateService.skipForPlanHash (prior/session read at consider() entry).
SkipForPlanHash(force, h) ==
    LET reReview  == force /\ gate.approved /\ gate.hash # h
        withdrawn == gate.dec = "approved" /\ ~gate.approved
    IN \/ gate.approved /\ ~reReview
       \/ phase # "planning" /\ ~reReview
       \/ ~force /\ ~withdrawn /\ gate.exists /\ gate.hash = h /\ gate.dec # "error"
       \/ ~force /\ cancelled = h

\* PlanGateService.buildGate.
BuildGate(v, h, sp) ==
    [exists |-> TRUE, dec |-> v, approved |-> v = "approved", hash |-> h,
     approvedAt |-> (v = "approved" \/ gate.approvedAt), upd |-> clock + 1,
     by |-> IF v = "approved" THEN "reviewer" ELSE "none", src |-> sp]

\* orphanDisposition + isReReviewSpawn.
Disposition(s) ==
    LET reReview == gate.approved /\ spawns[s].at > gate.upd
    IN IF phase = "executing" THEN (IF reReview THEN "adopt" ELSE "skip")
       ELSE IF gate.approved /\ ~reReview THEN "reap" ELSE "adopt"

\* server.ts goRefusal(): null (= OK) for a `mode: "go"` edit on base `b`.
GoAllowed(b) == phase = "planning" /\ gate.approved /\ b = gate.hash

-----------------------------------------------------------------------------
(* Agent / world *)

AgentEditsPlan ==
    /\ edits < MaxEdits
    /\ \E p \in Plans \ {livePlan} : livePlan' = p
    /\ edits' = edits + 1
    /\ UNCHANGED <<phase, via, prOpen, auto, storeVars, memVars, consVars, finVars,
                   goVars, editVars, bootVars>>

PrOpens ==
    /\ ~prOpen /\ prOpen' = TRUE
    /\ UNCHANGED <<phase, via, livePlan, edits, auto, storeVars, memVars, consVars,
                   finVars, goVars, editVars, bootVars>>

\* Reviewer writes its verdict file ("error" = timeout / unparseable / no verdict).
ReviewerVerdict ==
    \E s \in Spawn, v \in {"approved", "changes", "error"} :
        /\ spawns[s].st = "open" /\ spawns[s].wt /\ spawns[s].verdict = "pending"
        /\ spawns' = [spawns EXCEPT ![s].verdict = v]
        /\ UNCHANGED <<sessVars, gate, nSp, clock, memVars, consVars, finVars, goVars,
                       editVars, bootVars>>

-----------------------------------------------------------------------------
(* PlanGateService.consider() -> begin() *)

\* Sync guards + `starting` claim; plan read; skipForPlanHash (prior snapshot from entry).
ConsiderStart ==
    \E force \in BOOLEAN :
        /\ cpc = "idle" /\ nSp < MaxSpawns
        /\ "bootRace" \in Fixes => boot = "done"
        /\ ~inflight.on /\ ~starting
        /\ force \/ phase = "planning"
        /\ force \/ ~gate.approved
        /\ ~SkipForPlanHash(force, livePlan)
        /\ starting' = TRUE
        /\ cpc' = "begin" /\ cPlan' = livePlan /\ cForce' = force
        /\ UNCHANGED <<sessVars, storeVars, inflight, cancelled, cSp, finVars, goVars,
                       editVars, bootVars>>

\* After fetchIssueBody/createDetached: begin()'s single re-check of `starting` (forget/reap tombstone).
ConsiderRecheck ==
    /\ cpc = "begin"
    /\ cpc' = IF starting THEN "aux" ELSE "idle"
    /\ UNCHANGED <<sessVars, storeVars, memVars, cPlan, cForce, cSp, finVars, goVars, editVars,
                   bootVars>>

\* After `await resolveAuxPatch`: persist ownership (recordReviewerSpawn) before launch, with NO
\* second `starting` re-check, so a reapReviewer during resolveAuxPatch does not abort the spawn.
ConsiderSpawn ==
    /\ cpc = "aux"
    /\ nSp' = nSp + 1 /\ clock' = clock + 1 /\ cSp' = nSp + 1
    /\ spawns' = [spawns EXCEPT ![nSp + 1] =
                    [st |-> "open", wt |-> TRUE, at |-> clock + 1, rev |-> cPlan,
                     verdict |-> "pending"]]
    /\ cpc' = "launch"
    /\ UNCHANGED <<sessVars, gate, memVars, cPlan, cForce, finVars, goVars, editVars, bootVars>>

\* After herdr.start: inflight.set (no re-check), `starting` cleared in consider()'s finally.
ConsiderLaunch ==
    /\ cpc = "launch"
    /\ inflight' = [on |-> TRUE, sp |-> cSp, hash |-> cPlan, fin |-> FALSE]
    /\ starting' = FALSE /\ cpc' = "idle"
    /\ UNCHANGED <<sessVars, storeVars, cancelled, cPlan, cForce, cSp, finVars, goVars,
                   editVars, bootVars>>

-----------------------------------------------------------------------------
(* PlanGateService.tick() -> finalize() *)

\* Claim (finalizing) + buildGate + the synchronous head of applyApproved / applyChangesRequested /
\* applyError.
TickFinalize ==
    /\ fpc = "idle"
    /\ inflight.on /\ ~inflight.fin
    /\ spawns[inflight.sp].wt /\ spawns[inflight.sp].verdict # "pending"
    /\ LET sp == inflight.sp
           v  == spawns[sp].verdict
           g  == BuildGate(v, inflight.hash, sp)
       IN /\ inflight' = [inflight EXCEPT !.fin = TRUE]
          /\ fSp' = sp /\ fGate' = g /\ clock' = clock + 1
          /\ CASE v = "approved" ->
                    \* applyApproved: putPlanGate, then (auto) await release -> releasePlanGate's
                    \* sync head (planReleaseInFlight dedupe, planning + approved guards).
                    /\ gate' = g
                    /\ IF auto /\ gpc = "idle" /\ phase = "planning"
                         THEN gpc' = "steer" /\ gHash' = g.hash
                         ELSE UNCHANGED goVars
                    /\ fpc' = IF auto THEN "release" ELSE "usage"
                    /\ UNCHANGED <<phase, via>>
               [] v = "changes" ->
                    \* applyChangesRequested: re-gate an approved EXECUTING session (provisional
                    \* put + regatePlanGate's sync head), then await the findings steer.
                    /\ IF gate.approved /\ phase = "executing"
                         THEN gate' = g /\ phase' = "planning" /\ via' = "none"
                         ELSE /\ gate' = IF "tailPut" \in Fixes /\ gate.approved THEN g ELSE gate
                              /\ UNCHANGED <<phase, via>>
                    /\ fpc' = "steer"
                    /\ UNCHANGED goVars
               [] v = "error" ->
                    \* applyError: persist only over a non-approved gate.
                    /\ gate' = IF gate.approved THEN gate ELSE g
                    /\ fpc' = "usage"
                    /\ UNCHANGED <<phase, via, goVars>>
    /\ UNCHANGED <<livePlan, edits, prOpen, auto, spawns, nSp, starting, cancelled,
                   consVars, editVars, bootVars>>

\* applyApproved's `await release` resolves (the release it started, or one already pending).
FinalizeAfterRelease ==
    /\ fpc = "release" /\ gpc = "idle"
    /\ fpc' = "usage"
    /\ UNCHANGED <<sessVars, storeVars, memVars, consVars, fSp, fGate, goVars, editVars,
                   bootVars>>

\* applyChangesRequested's tail putPlanGate, after the findings steer resolved.
FinalizeTailPut ==
    /\ fpc = "steer"
    /\ gate' = fGate /\ fpc' = "usage"
    /\ UNCHANGED <<sessVars, spawns, nSp, clock, memVars, consVars, fSp, fGate, goVars,
                   editVars, bootVars>>

\* captureRunUsage -> completeReviewerSpawn.
FinalizeUsage ==
    /\ fpc = "usage"
    /\ spawns' = [spawns EXCEPT ![fSp].st = "done"] /\ fpc' = "reap"
    /\ UNCHANGED <<sessVars, gate, nSp, clock, memVars, consVars, fSp, fGate, goVars,
                   editVars, bootVars>>

\* finally: herdr.stop, worktree.remove; tick()'s finally: dropInflight (deletes by session id).
FinalizeReap ==
    /\ fpc = "reap"
    /\ spawns' = [spawns EXCEPT ![fSp].wt = FALSE]
    /\ inflight' = IF "dropOwn" \in Fixes /\ inflight.sp # fSp THEN inflight ELSE NoInflight
    /\ fpc' = "idle"
    /\ UNCHANGED <<sessVars, gate, nSp, clock, starting, cancelled, consVars, fSp, fGate,
                   goVars, editVars, bootVars>>

-----------------------------------------------------------------------------
(* Phase transitions to "executing" (SessionService) *)

\* releasePlanGate (operator Go): sync head up to `await resumeAndReply`.
GoStart ==
    /\ gpc = "idle" /\ phase = "planning" /\ gate.approved
    /\ gpc' = "steer" /\ gHash' = gate.hash
    /\ UNCHANGED <<sessVars, storeVars, memVars, consVars, finVars, editVars, bootVars>>

\* Steer resolved: re-check (still planning, approved, same planHash) -> #enterExecution.
\* Delivery failure returns false without a transition.
GoFinish ==
    /\ gpc = "steer" /\ gpc' = "idle"
    /\ \/ /\ phase = "planning" /\ gate.approved /\ gate.hash = gHash
          /\ phase' = "executing" /\ via' = "go"
       \/ UNCHANGED <<phase, via>>
    /\ UNCHANGED <<livePlan, edits, prOpen, auto, storeVars, memVars, consVars, finVars,
                   gHash, editVars, bootVars>>

\* releasePlanOnOperatorReply (chat release).
ChatRelease ==
    /\ phase = "planning" /\ gate.approved
    /\ phase' = "executing" /\ via' = "chat"
    /\ UNCHANGED <<livePlan, edits, prOpen, auto, storeVars, memVars, consVars, finVars,
                   goVars, editVars, bootVars>>

\* advanceToExecutionOnPr + planGate.reapReviewer (index.ts, git poll).
PrAdvance ==
    /\ prOpen /\ phase = "planning"
    /\ ~(gate.exists /\ ~gate.approved /\ gate.approvedAt)
    /\ phase' = "executing" /\ via' = "pr"
    /\ ReapReviewer
    /\ UNCHANGED <<livePlan, edits, prOpen, auto, gate, nSp, clock, cancelled, consVars,
                   finVars, goVars, editVars, bootVars>>

-----------------------------------------------------------------------------
(* POST /api/sessions/:id/plan-edits (handleSessionPlanEdits) *)

\* planEditLanding (no Go in flight; go-mode refusal) then `await planGate.cancel()`:
\* claimForCancel + dropInflight + markCancelled run synchronously. "skipped" (mid-spawn or
\* finalizing) refuses the request, so the action is simply not enabled then.
EditStart ==
    \E mode \in {"resubmit", "go"} :
        /\ epc = "idle" /\ gpc = "idle" /\ edits < MaxEdits
        /\ mode = "go" => GoAllowed(livePlan)
        /\ ~starting /\ ~(inflight.on /\ inflight.fin)
        /\ eMode' = mode /\ eBase' = livePlan
        /\ IF inflight.on
             THEN /\ inflight' = NoInflight /\ cancelled' = inflight.hash
                  /\ eSp' = inflight.sp /\ epc' = "cancel"
             ELSE /\ UNCHANGED <<inflight, cancelled>>
                  /\ eSp' = 0 /\ epc' = "land"
        /\ UNCHANGED <<sessVars, storeVars, starting, consVars, finVars, goVars, bootVars>>

\* cancel()'s captureRunUsage + reapRun resolved.
EditCancelDone ==
    /\ epc = "cancel"
    /\ spawns' = [spawns EXCEPT ![eSp].st = "done", ![eSp].wt = FALSE]
    /\ epc' = "land"
    /\ UNCHANGED <<sessVars, gate, nSp, clock, memVars, consVars, finVars, goVars, eMode,
                   eBase, eSp, bootVars>>

\* Re-check landing, applyPlanEdit (file + gateAfterPlanEdit), then deliverPlanEdit's sync head:
\* go -> releasePlanGate; resubmit on an executing session -> regateForPlanEdit (#regate).
EditLand ==
    /\ epc = "land" /\ epc' = "idle"
    /\ IF gpc # "idle" \/ livePlan # eBase \/ edits >= MaxEdits
          \/ (eMode = "go" /\ ~GoAllowed(eBase))
         THEN UNCHANGED <<sessVars, gate, goVars>>
         ELSE \E p \in Plans \ {eBase} :
                LET g2 == IF ~gate.approved THEN gate
                          ELSE IF eMode = "resubmit" THEN [gate EXCEPT !.approved = FALSE]
                          ELSE [gate EXCEPT !.hash = p, !.by = "operator"]
                IN /\ livePlan' = p /\ edits' = edits + 1 /\ gate' = g2
                   /\ IF eMode = "go"
                        THEN /\ gpc' = "steer" /\ gHash' = g2.hash
                             /\ UNCHANGED <<phase, via>>
                        ELSE /\ IF phase = "executing" /\ g2.exists /\ ~g2.approved
                                  THEN phase' = "planning" /\ via' = "none"
                                  ELSE UNCHANGED <<phase, via>>
                             /\ UNCHANGED goVars
                   /\ UNCHANGED <<prOpen, auto>>
    /\ UNCHANGED <<spawns, nSp, clock, memVars, consVars, finVars, eMode, eBase, eSp, bootVars>>

-----------------------------------------------------------------------------
(* Restart + boot chain (index.ts deferredStarts) *)

\* Process dies: every in-memory structure and in-progress call is lost. Reviewer panes (herdr),
\* worktrees, verdict files and all DB rows survive. adoptOrphans snapshots the open rows.
Restart ==
    /\ restarts < MaxRestarts /\ restarts' = restarts + 1
    /\ inflight' = NoInflight /\ starting' = FALSE /\ cancelled' = NoPlan
    /\ cpc' = "idle" /\ fpc' = "idle" /\ gpc' = "idle" /\ epc' = "idle"
    /\ boot' = "adopt" /\ apc' = "idle"
    /\ aTodo' = {s \in Spawn : spawns[s].st = "open"}
    /\ UNCHANGED <<sessVars, storeVars, cPlan, cForce, cSp, fSp, fGate, gHash, eMode, eBase,
                   eSp, aSp, aPlan>>

\* adoptOrphans loop body (newest first), sync part: inflight/starting skip, disposition, worktree
\* check; for "adopt", buildAdoptedInflight reads the CURRENT plan before its awaits.
AdoptVisit ==
    /\ boot = "adopt" /\ apc = "idle" /\ aTodo # {}
    /\ LET s == Max(aTodo) IN
         /\ aTodo' = aTodo \ {s}
         /\ IF inflight.on \/ starting \/ Disposition(s) = "skip" \/ ~spawns[s].wt
              THEN UNCHANGED <<apc, aSp, aPlan>>
              ELSE /\ apc' = IF Disposition(s) = "reap" THEN "reap" ELSE "adopt"
                   /\ aSp' = s
                   /\ aPlan' = IF "adoptPlan" \in Fixes THEN spawns[s].rev ELSE livePlan
    /\ UNCHANGED <<sessVars, storeVars, memVars, consVars, finVars, goVars, editVars, boot,
                   restarts>>

\* reapOrphanSpawn resolved: complete the row, remove the worktree.
AdoptReap ==
    /\ apc = "reap"
    /\ spawns' = [spawns EXCEPT ![aSp].st = "done", ![aSp].wt = FALSE]
    /\ apc' = "idle"
    /\ UNCHANGED <<sessVars, gate, nSp, clock, memVars, consVars, finVars, goVars, editVars,
                   boot, aTodo, aSp, aPlan, restarts>>

\* buildAdoptedInflight resolved: inflight.set with no re-check; planHash = hash of the plan read.
AdoptSet ==
    /\ apc = "adopt"
    /\ inflight' = [on |-> TRUE, sp |-> aSp, hash |-> aPlan, fin |-> FALSE]
    /\ apc' = "idle"
    /\ UNCHANGED <<sessVars, storeVars, starting, cancelled, consVars, finVars, goVars,
                   editVars, boot, aTodo, aSp, aPlan, restarts>>

\* gcStaleReviewWorktrees: remove the worktree of every open row not owned by `inflight`.
BootGc ==
    /\ boot = "adopt" /\ apc = "idle" /\ aTodo = {}
    /\ spawns' = [s \in Spawn |->
                    IF spawns[s].st = "open" /\ spawns[s].wt /\ ~(inflight.on /\ inflight.sp = s)
                      THEN [spawns[s] EXCEPT !.wt = FALSE] ELSE spawns[s]]
    /\ boot' = "done"
    /\ UNCHANGED <<sessVars, gate, nSp, clock, memVars, consVars, finVars, goVars, editVars,
                   aTodo, apc, aSp, aPlan, restarts>>

-----------------------------------------------------------------------------
Next ==
    \/ AgentEditsPlan \/ PrOpens \/ ReviewerVerdict
    \/ ConsiderStart \/ ConsiderRecheck \/ ConsiderSpawn \/ ConsiderLaunch
    \/ TickFinalize \/ FinalizeAfterRelease \/ FinalizeTailPut \/ FinalizeUsage \/ FinalizeReap
    \/ GoStart \/ GoFinish \/ ChatRelease \/ PrAdvance
    \/ EditStart \/ EditCancelDone \/ EditLand
    \/ Restart \/ AdoptVisit \/ AdoptReap \/ AdoptSet \/ BootGc

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Operator-chosen properties (#4154). *)

\* INV-ExecApproved (narrowed): entering "executing" through Go or the chat release requires an
\* approved gate; for Go, on the planHash snapshotted when Go started. PR auto-advance (#809) is
\* excluded by design.
ExecApproved ==
    [][(phase = "planning" /\ phase' = "executing" /\ via' \in {"go", "chat"})
         => (gate'.approved /\ (via' = "go" => gate'.hash = gHash))]_vars

\* INV-ApprovalMatchesReviewed: a reviewer's approval is stamped on the hash of the text that
\* reviewer actually read. (An operator `go` edit moves the approval on purpose, #3518.)
ApprovalMatchesReviewed ==
    (gate.approved /\ gate.by = "reviewer") => gate.hash = spawns[gate.src].rev

\* INV-NoStaleReviewer: past an approval, a reviewer whose verdict is still pending (not yet
\* claimed by finalize) is a #2224 re-review of a different plan.
NoStaleReviewer ==
    (gate.approved /\ inflight.on /\ ~inflight.fin) => spawns[inflight.sp].rev # gate.hash

\* INV-RegateSticks: a deliberately re-gated gate (approved before, not now) keeps the session in
\* planning, and nothing moves it to executing until re-approval.
RegateSticks ==
    (gate.exists /\ gate.approvedAt /\ ~gate.approved) => phase = "planning"

NoExecWhileRegated ==
    [][(phase = "planning" /\ phase' = "executing")
         => ~(gate.exists /\ gate.approvedAt /\ ~gate.approved)]_vars

\* INV-NoLeakedSpawn: once boot recovery is done and no call is mid-flight, every open spawn row
\* whose worktree still exists is owned by `inflight`.
Quiescent == boot = "done" /\ cpc = "idle" /\ fpc = "idle" /\ epc = "idle" /\ apc = "idle"

NoLeakedSpawn ==
    Quiescent => \A s \in Spawn :
        (spawns[s].st = "open" /\ spawns[s].wt) => (inflight.on /\ inflight.sp = s)

\* INV-SingleReviewer: outside the boot window, at most one live, un-reaped reviewer (open row +
\* worktree, not already being torn down by a cancel / finalize / orphan reap in progress).
TearingDown(s) ==
    \/ epc = "cancel" /\ eSp = s
    \/ fpc \in {"usage", "reap"} /\ fSp = s
    \/ apc = "reap" /\ aSp = s

SingleReviewer ==
    boot = "done" =>
        Cardinality({s \in Spawn : spawns[s].st = "open" /\ spawns[s].wt /\ ~TearingDown(s)}) <= 1

=============================================================================
