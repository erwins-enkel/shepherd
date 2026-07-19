import type { ChecksState, MergeStateStatus, PrStatus } from "./forge/types";
import type { ReviewDecision } from "./types";
import type { ManualStep } from "./manual-steps";
import { signedOff, type SignoffAuthority } from "./signoff";
import { checksCleared } from "./checks-gate";
import { isDefiniteConflict } from "./pr-conflict";

/** How long a conflict-path rebase steer suppresses a re-steer for the SAME head. A conflicting
 *  head never moves, so a permanent per-head dedup would wedge the PR below rebaseCap forever
 *  (the cap check lives behind needsRebase). Expiring it is what lets the cap be reached. */
export const REBASE_DEDUP_TTL_MS = 10 * 60_000;

/** How long that same steer marks the session as train-owned, so autopilot's CI-fix loop stands
 *  down. 2x the dedup TTL so a train re-steering exactly on the dedup boundary always refreshes
 *  ownership BEFORE it lapses — at 1x the two windows race and a spurious CI_FIX_STEER fires. */
export const OWNERSHIP_TTL_MS = 2 * REBASE_DEDUP_TTL_MS;

/** Why the merge train is holding — surfaced on automerge:status. */
export interface MergeHoldReason {
  code: "disabled" | "rebase_cap" | "idle" | "manual_steps";
  /** A desig (rebase_cap / manual_steps) for the operator banner. */
  detail?: string;
  /** The affected session's id, so the push deep-link selects it (rebase_cap / manual_steps). */
  sessionId?: string;
}

export type MergeDecision =
  | { kind: "merge"; sessionId: string; prNumber: number; headSha: string | null }
  | { kind: "rebase"; sessionId: string; headSha: string | null; conflict: boolean }
  | { kind: "hold"; reason: MergeHoldReason };

/** The slice of one full-auto session the merge core reasons over. */
export interface MergeSessionView {
  id: string;
  desig: string;
  state: PrStatus["state"];
  checks: ChecksState;
  /** True when the repo has no CI to wait on (GitHub + zero workflows): a terminal checks:"none"
   *  counts as cleared for merge. Projected from the cached GitState's noCi. */
  noCi: boolean;
  /** null = host still computing; treat as not-yet-mergeable. */
  mergeable: boolean | null;
  /** GitHub branch-protection merge state; absent on forges that do not supply it. */
  mergeStateStatus?: MergeStateStatus;
  number: number | null;
  headSha: string | null;
  /** false = up-to-date; true = behind main (rebase); null = unknown (never merge). */
  behind: boolean | null;
  reviewDecision: ReviewDecision | null;
  reviewHeadSha: string | null;
  /** The PR is a draft (not ready-for-review). false when unknown/no PR. */
  isDraft: boolean;
  /** A human submitted an APPROVED review on the PR (forge data). */
  humanApproved: boolean;
  /** The latest critic verdict's discrete findings ([] = clean / none). */
  findings: string[];
  /** Consecutive auto-rebase attempts already spent on this session. */
  rebaseCount: number;
  /** The head SHA a rebase was last steered for; when it equals headSha a rebase is
   *  already outstanding/in-progress, so the core must not re-steer or re-bump. */
  rebaseSteeredHead: string | null;
  /** Epoch ms of that steer; null when never steered. On the CONFLICT path the dedup above
   *  expires after REBASE_DEDUP_TTL_MS so the cap becomes reachable on a head that never moves. */
  rebaseSteeredAt: number | null;
  /** True while the agent is working (status running|blocked). The train has no tick-level
   *  idleness filter of its own — buildState filters only archived+fullAuto — unlike
   *  autopilot.tick(), so without this the conflict path would re-steer mid-resolution. */
  busy: boolean;
  /** True when this PR's merge is backed off (CAP rapid failures on the current head,
   *  inside the backoff window) → the core skips it so siblings can still merge. */
  mergeBlocked: boolean;
  /** Manual operator steps detected in the PR body (#1059); [] when none. A non-`POST-MERGE`
   *  step that is still un-acked (`manualStepsAckedAt == null`) holds auto-merge (#1060). */
  manualSteps: ManualStep[];
  /** Epoch ms the operator acknowledged the manual steps; null until acked. */
  manualStepsAckedAt: number | null;
}

export interface MergeRepoState {
  enabled: boolean;
  /** When on, a clean critic verdict for the CURRENT head gates the merge. */
  criticEnabled: boolean;
  /** Per-repo draft mode — merges are gated on sign-off (defense-in-depth, see readyToMerge). */
  draftMode: boolean;
  /** Who can sign off a draft-mode PR ("human"|"critic"|"either"). */
  signoffAuthority: SignoffAuthority;
  rebaseCap: number;
  /** Wall clock for the expiring conflict dedup, stamped by buildState so the core stays pure. */
  now: number;
  /** Non-archived full-auto sessions for this repo. */
  sessions: MergeSessionView[];
}

/** Sign-off view for a draft-mode merge gate, projected off the flat MergeSessionView. */
function signoffView(s: MergeSessionView) {
  return {
    humanApproved: s.humanApproved,
    reviewDecision: s.reviewDecision,
    findings: s.findings,
    reviewHeadSha: s.reviewHeadSha,
    headSha: s.headSha,
  };
}

/** True when an un-acked, non-`POST-MERGE` manual operator step holds this PR (#1060). A
 *  `POST-MERGE`-only PR never qualifies (those never gate — they only inform + carry forward).
 *  Used as the `readyToMerge` disqualifier AND the rundown signal predicate — NOT as the
 *  hold/push trigger (that additionally needs readyExceptManualSteps; see computeMerge). */
function hasBlockingManualSteps(s: MergeSessionView): boolean {
  return s.manualStepsAckedAt == null && s.manualSteps.some((st) => !st.postMerge);
}

/** True when this PR is clean enough to land RIGHT NOW *ignoring* the manual-steps gate: open,
 *  green, host-mergeable, up-to-date with main, and (critic on) a clean verdict for the current
 *  head. Split out from readyToMerge so computeMerge can tell "otherwise-ready, held only on
 *  un-acked steps" (→ a manual_steps hold) apart from a PR that is red/draft/stale on its own
 *  merits (which must NOT surface as a manual-steps hold or fire its push).
 *
 *  In draftMode it ALSO requires the configured `authority`'s sign-off. draftMode repos force
 *  auto-merge OFF (Task 1), so the merge train normally has NO sessions for them — this gate is
 *  defense-in-depth for config drift (a stray full-auto session in a draft repo), NOT dead code:
 *  it's exercised by tests. */
function readyExceptManualSteps(
  s: MergeSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  if (s.mergeBlocked) return false; // backed off after repeated merge failures → skip, try siblings
  if (s.state !== "open" || !checksCleared(s.checks, s.noCi) || s.mergeable !== true || !s.number)
    return false;
  if (s.mergeStateStatus === "blocked") return false;
  if (s.behind !== false) return false; // true=stale, null=unknown → not now
  if (draftMode && !signedOff(authority, signoffView(s))) return false; // backstop: never merge an unsigned draft
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled) {
    if (s.reviewDecision === null) return false;
    if (s.reviewHeadSha !== s.headSha) return false;
  }
  return true;
}

/** True when this PR is clean enough to land RIGHT NOW: readyExceptManualSteps AND not held by an
 *  un-acked non-`POST-MERGE` manual step (#1060). */
function readyToMerge(
  s: MergeSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  return (
    readyExceptManualSteps(s, criticEnabled, draftMode, authority) && !hasBlockingManualSteps(s)
  );
}

/** ELIGIBILITY — does this PR WARRANT a rebase, ignoring whether now is a good moment?
 *
 *  Split from availability so the two questions cannot drift: `needsRebase` is literally
 *  `rebaseEligible && rebaseAvailable`. Kept module-private — autopilot deliberately does NOT
 *  re-derive this to decide whether the train owns a session; it reads the recorded
 *  `autoMergeRebaseSteeredAt` stamp instead, so there is no cross-module predicate to keep in step.
 *
 *  DEFECT A: a conflicting PR can never satisfy `checksCleared`. GitHub cannot build
 *  `refs/pull/N/merge`, so no `pull_request` workflow runs, so `checks` stays "none" — which
 *  simultaneously shuts the critic (review.ts's consider), this predicate, and autopilot's
 *  rebaseCandidate. A rebase would require green CI, and green CI would require a rebase. So the
 *  CI-green gate is waived for a DEFINITE conflict only, where it is unsatisfiable by
 *  construction; a `behind` PR with pending checks keeps it (CI is genuinely still coming).
 */
function rebaseEligible(
  s: MergeSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  if (s.state !== "open" || !s.number) return false;
  if (!isDefiniteConflict(s) && !checksCleared(s.checks, s.noCi)) return false;
  // draftMode: never rebase an unsigned PR (don't churn CI on a draft awaiting sign-off).
  if (draftMode && !signedOff(authority, signoffView(s))) return false;
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled && s.reviewDecision !== null && s.reviewHeadSha !== s.headSha) {
    // a re-review is already pending for a newer head → let the critic settle first
    return false;
  }
  // `|| isDefiniteConflict` is load-bearing: a `dirty` PR whose `mergeable` is still null would
  // otherwise clear every gate above and then decline here, contradicting the predicate itself.
  return s.behind === true || s.mergeable === false || isDefiniteConflict(s);
}

/** AVAILABILITY — is NOW the moment to act on an eligible PR? */
function rebaseAvailable(s: MergeSessionView, now: number): boolean {
  // The train has no tick-level idleness filter (unlike autopilot.tick()), so without this it
  // would re-steer an agent midway through resolving the conflict.
  if (isDefiniteConflict(s) && s.busy) return false;
  if (s.headSha === null || s.rebaseSteeredHead !== s.headSha) return true;
  // Same head already steered. behind-only keeps today's permanent dedup — its head DOES move
  // once the agent rebases. A conflicting head may never move, so that dedup EXPIRES (Defect D):
  // otherwise needsRebase stays false forever and computeMerge's cap check, which sits behind it,
  // is never evaluated — wedging the PR below the cap with no hand-back.
  if (!isDefiniteConflict(s)) return false;
  // Branch null explicitly rather than relying on `now - null`: a behind-path steer whose PR
  // later goes dirty has a head recorded but no timestamp. Fail open toward acting.
  if (s.rebaseSteeredAt === null) return true;
  return now - s.rebaseSteeredAt >= REBASE_DEDUP_TTL_MS;
}

/** True when the PR warrants a rebase AND now is the moment. Composed from the two halves above
 *  so they cannot diverge. */
function needsRebase(
  s: MergeSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
  now: number,
): boolean {
  return rebaseEligible(s, criticEnabled, draftMode, authority) && rebaseAvailable(s, now);
}

/**
 * Pure decision core for the merge train. One action per call; the harness applies
 * it, re-reads, and calls again. Merges take priority over rebases (land what's ready
 * before disturbing siblings), and within each, NEXT-IN-LINE wins (first actionable),
 * not oldest-first — see the spec's throughput decision.
 */
export function computeMerge(state: MergeRepoState): MergeDecision {
  if (!state.enabled) return { kind: "hold", reason: { code: "disabled" } };

  const ready = state.sessions.find((s) =>
    readyToMerge(s, state.criticEnabled, state.draftMode, state.signoffAuthority),
  );
  if (ready)
    return { kind: "merge", sessionId: ready.id, prNumber: ready.number!, headSha: ready.headSha };

  // Scan rebase-eligible sessions BEFORE capped ones. A permanently-conflicting session at the
  // cap never refreshes rebaseSteeredAt (it gets a hold, not a rebase), so its dedup stays expired
  // and needsRebase stays true forever — a single find() would return it on every pump and starve
  // every sibling of a rebase decision. Landing progress beats reporting an exhausted budget.
  //
  // The two scans ask DIFFERENT questions, so they use different predicates. The `stale` scan is
  // about to ACT, so it needs full availability (needsRebase = eligibility AND "now is the
  // moment"). The `capped` scan only REPORTS an exhausted budget — a fact that is already true
  // and does not become truer by waiting. Gating it on availability too would suppress the
  // rebase_cap hold (and with it the train-error signal and the merge_attention push) for a whole
  // REBASE_DEDUP_TTL_MS after the cap-reaching rebase, while the train reported `idle` — and
  // would hide it indefinitely for a session stuck busy behind rebaseAvailable's busy gate.
  const eligible = (s: MergeSessionView) =>
    rebaseEligible(s, state.criticEnabled, state.draftMode, state.signoffAuthority);

  const stale = state.sessions.find(
    (s) =>
      needsRebase(s, state.criticEnabled, state.draftMode, state.signoffAuthority, state.now) &&
      s.rebaseCount < state.rebaseCap,
  );
  if (stale) {
    return {
      kind: "rebase",
      sessionId: stale.id,
      headSha: stale.headSha,
      conflict: isDefiniteConflict(stale),
    };
  }

  const capped = state.sessions.find((s) => eligible(s) && s.rebaseCount >= state.rebaseCap);
  if (capped) {
    return {
      kind: "hold",
      reason: { code: "rebase_cap", detail: capped.desig, sessionId: capped.id },
    };
  }

  // A PR that is otherwise ready to land but held ONLY on un-acked non-POST-MERGE manual steps
  // (#1060). Reported as a distinct hold (not idle) so the operator learns which PR is held and
  // why; gated on readyExceptManualSteps so a red/draft/stale PR that merely declares steps never
  // surfaces here (and never fires the manual_steps push, which rides this hold's status event).
  const heldManual = state.sessions.find(
    (s) =>
      readyExceptManualSteps(s, state.criticEnabled, state.draftMode, state.signoffAuthority) &&
      hasBlockingManualSteps(s),
  );
  if (heldManual) {
    return {
      kind: "hold",
      reason: { code: "manual_steps", detail: heldManual.desig, sessionId: heldManual.id },
    };
  }

  return { kind: "hold", reason: { code: "idle" } };
}
