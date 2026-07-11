import type { GitState, ReviewVerdict, ChecksState } from "$lib/types";
import { verdictStale } from "$lib/verdict-freshness";

/** Pipeline stages, low→high. The agent's furthest-reached stage drives the stepper. */
export const STAGE_ORDER = ["planning", "implementing", "pr", "review", "ready"] as const;
export type Stage = (typeof STAGE_ORDER)[number];

/** Index of the PR stage in STAGE_ORDER — use instead of a hardcoded `2`. */
export const PR_INDEX = STAGE_ORDER.indexOf("pr");

/** Index of the review stage in STAGE_ORDER — use instead of a hardcoded `3`. */
export const REVIEW_INDEX = STAGE_ORDER.indexOf("review");

export interface StageInfo {
  /** Highest stage reached. */
  reached: Stage;
  /** 0..STAGE_ORDER.length-1 — index of `reached` in STAGE_ORDER. */
  index: number;
  /** CI rollup, for tinting the PR segment once the pr stage is reached ("none" when no PR). */
  ci: ChecksState;
  /** PR merged/closed → row shows a terminal chip, not the stepper. */
  terminal: "merged" | "closed" | null;
  /** Tint state for the review segment.
   *  Priority: reviewing → changes → approved → error → none. */
  review: "none" | "reviewing" | "changes" | "approved" | "error";
  /** True when planPhase==null (gate off); legend will say "skipped". */
  planningSkipped: boolean;
}

/**
 * Whether the critic verdict counts as an approval.
 * git.headSha guard is load-bearing — undefined===undefined must not pass.
 * ReviewVerdict.headSha is typed required but arrives as wire JSON where it can be absent.
 */
function isReviewOk(git: GitState | undefined, verdict: ReviewVerdict | undefined): boolean {
  if (git?.latestReview?.state === "approved") return true;
  return (
    verdict?.decision === "commented" && git?.headSha != null && verdict.headSha === git.headSha
  );
}

/** Whether all conditions for the ready stage are met. */
function isDerivedReady(git: GitState | undefined, reviewOk: boolean): boolean {
  return (
    git?.state === "open" &&
    git.checks === "success" &&
    git.mergeable === true &&
    !git.isDraft &&
    reviewOk
  );
}

/** Pure helper — maps git/verdict signals to the review-segment tint. */
function reviewTint(
  reviewing: boolean,
  reviewOk: boolean,
  verdict: ReviewVerdict | undefined,
  git: GitState | undefined,
): StageInfo["review"] {
  if (reviewing) return "reviewing";
  // A critic verdict for an OLDER head (rework pushed, PR open at a newer head, re-review pending)
  // is stale — don't paint it red. The human forge review (git.latestReview) is a separate fact.
  const criticStale = verdictStale(verdict?.headSha, git);
  if (
    (verdict?.decision === "changes_requested" && !criticStale) ||
    git?.latestReview?.state === "changes_requested"
  )
    return "changes";
  if (reviewOk) return "approved";
  if (verdict?.decision === "error" && !criticStale) return "error";
  return "none";
}

/**
 * Map the live git/review signals to the furthest pipeline stage reached.
 * Pure — no Svelte, no store reads (callers pass the reactive values in).
 */
export function deriveStage(input: {
  git?: GitState;
  verdict?: ReviewVerdict;
  reviewing: boolean;
  readyToMerge: boolean;
  planPhase?: "planning" | "executing" | null;
}): StageInfo {
  const { git, verdict, reviewing, readyToMerge, planPhase = null } = input;

  // index 0 (planning): only while planPhase === "planning".
  // index 1 (implementing): when planPhase === "executing" OR planPhase == null (gate off).
  let index = planPhase === "planning" ? 0 : 1;

  if (git?.state === "open") index = Math.max(index, PR_INDEX);
  if (reviewing || verdict || git?.latestReview) index = Math.max(index, REVIEW_INDEX);

  const reviewOk = isReviewOk(git, verdict);

  // Note: the UI hides the stepper entirely when readyToMerge, and merged shows a terminal
  // chip — so the derived predicate is the only path that actually paints a filled 5th
  // segment; the manual branch stays for purity/aria of any future caller.
  if (readyToMerge || git?.state === "merged" || isDerivedReady(git, reviewOk))
    index = STAGE_ORDER.length - 1; // ready

  const terminal = git?.state === "merged" ? "merged" : git?.state === "closed" ? "closed" : null;

  return {
    reached: STAGE_ORDER[index],
    index,
    ci: git?.checks ?? "none",
    terminal,
    review: reviewTint(reviewing, reviewOk, verdict, git),
    planningSkipped: planPhase === null,
  };
}
