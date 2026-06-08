import type { ChecksState, PrStatus } from "./forge/types";
import type { ReviewDecision } from "./types";

/** Why the merge train is holding — surfaced on automerge:status. */
export interface MergeHoldReason {
  code: "disabled" | "rebase_cap" | "idle";
  /** A desig (rebase_cap) for the operator banner. */
  detail?: string;
  /** The affected session's id, so the push deep-link selects it (rebase_cap). */
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
  /** null = host still computing; treat as not-yet-mergeable. */
  mergeable: boolean | null;
  number: number | null;
  headSha: string | null;
  /** false = up-to-date; true = behind main (rebase); null = unknown (never merge). */
  behind: boolean | null;
  reviewDecision: ReviewDecision | null;
  reviewHeadSha: string | null;
  /** Consecutive auto-rebase attempts already spent on this session. */
  rebaseCount: number;
  /** The head SHA a rebase was last steered for; when it equals headSha a rebase is
   *  already outstanding/in-progress, so the core must not re-steer or re-bump. */
  rebaseSteeredHead: string | null;
  /** True when this PR's merge is backed off (CAP rapid failures on the current head,
   *  inside the backoff window) → the core skips it so siblings can still merge. */
  mergeBlocked: boolean;
}

export interface MergeRepoState {
  enabled: boolean;
  /** When on, a clean critic verdict for the CURRENT head gates the merge. */
  criticEnabled: boolean;
  rebaseCap: number;
  /** Non-archived full-auto sessions for this repo. */
  sessions: MergeSessionView[];
}

/** True when this PR is clean enough to land RIGHT NOW: open, green, host-mergeable,
 *  up-to-date with main, and (critic on) a clean verdict for the current head. */
function readyToMerge(s: MergeSessionView, criticEnabled: boolean): boolean {
  if (s.mergeBlocked) return false; // backed off after repeated merge failures → skip, try siblings
  if (s.state !== "open" || s.checks !== "success" || s.mergeable !== true || !s.number)
    return false;
  if (s.behind !== false) return false; // true=stale, null=unknown → not now
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled) {
    if (s.reviewDecision === null) return false;
    if (s.reviewHeadSha !== s.headSha) return false;
  }
  return true;
}

/** True when the PR is otherwise mergeable-intent but stale or conflicting: open, green,
 *  critic not blocking, yet behind main OR host-unmergeable (textual conflict). A rebase
 *  (re-run CI + critic) is the path back to readiness. `behind: null` (unknown) is NOT a
 *  rebase trigger — we wait for a definite signal rather than thrash. */
function needsRebase(s: MergeSessionView, criticEnabled: boolean): boolean {
  if (s.state !== "open" || s.checks !== "success" || !s.number) return false;
  // A rebase for this exact head is already outstanding/in-progress → not actionable
  // (computeMerge falls through to an idle hold rather than re-steer + re-bump).
  if (s.headSha !== null && s.rebaseSteeredHead === s.headSha) return false;
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

  const ready = state.sessions.find((s) => readyToMerge(s, state.criticEnabled));
  if (ready)
    return { kind: "merge", sessionId: ready.id, prNumber: ready.number!, headSha: ready.headSha };

  const stale = state.sessions.find((s) => needsRebase(s, state.criticEnabled));
  if (stale) {
    if (stale.rebaseCount >= state.rebaseCap) {
      return {
        kind: "hold",
        reason: { code: "rebase_cap", detail: stale.desig, sessionId: stale.id },
      };
    }
    return { kind: "rebase", sessionId: stale.id, headSha: stale.headSha };
  }

  return { kind: "hold", reason: { code: "idle" } };
}
