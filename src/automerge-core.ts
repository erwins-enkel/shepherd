import type { ChecksState, MergeStateStatus, PrStatus } from "./forge/types";
import type { ReviewDecision } from "./types";
import type { ManualStep } from "./manual-steps";
import { signedOff, type SignoffAuthority } from "./signoff";
import { checksCleared } from "./checks-gate";

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
  | { kind: "rebase"; sessionId: string; headSha: string | null }
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

/** True when the PR is otherwise mergeable-intent but stale or conflicting: open, green,
 *  critic not blocking, yet behind main OR host-unmergeable (textual conflict). A rebase
 *  (re-run CI + critic) is the path back to readiness. `behind: null` (unknown) is NOT a
 *  rebase trigger — we wait for a definite signal rather than thrash. */
function needsRebase(
  s: MergeSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  if (s.state !== "open" || !checksCleared(s.checks, s.noCi) || !s.number) return false;
  // A rebase for this exact head is already outstanding/in-progress → not actionable
  // (computeMerge falls through to an idle hold rather than re-steer + re-bump).
  if (s.headSha !== null && s.rebaseSteeredHead === s.headSha) return false;
  // draftMode: never rebase an unsigned PR (don't churn CI on a draft awaiting sign-off).
  if (draftMode && !signedOff(authority, signoffView(s))) return false;
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled && s.reviewDecision !== null && s.reviewHeadSha !== s.headSha) {
    // a re-review is already pending for a newer head → let the critic settle first
    return false;
  }
  return s.behind === true || s.mergeable === false;
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

  const stale = state.sessions.find((s) =>
    needsRebase(s, state.criticEnabled, state.draftMode, state.signoffAuthority),
  );
  if (stale) {
    if (stale.rebaseCount >= state.rebaseCap) {
      return {
        kind: "hold",
        reason: { code: "rebase_cap", detail: stale.desig, sessionId: stale.id },
      };
    }
    return { kind: "rebase", sessionId: stale.id, headSha: stale.headSha };
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
