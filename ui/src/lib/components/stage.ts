import type { GitState, ReviewVerdict, ChecksState } from "$lib/types";

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
  /** 0..4 — index of `reached` in STAGE_ORDER. */
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

  if (git?.state === "open") {
    index = Math.max(index, PR_INDEX); // pr
  }

  if (reviewing || verdict || git?.latestReview) index = Math.max(index, REVIEW_INDEX); // review

  // reviewOk: git.headSha guard is load-bearing — undefined===undefined must not pass
  const reviewOk =
    git?.latestReview?.state === "approved" ||
    (verdict?.decision === "commented" && git?.headSha != null && verdict.headSha === git.headSha);

  const derivedReady =
    git?.state === "open" &&
    git.checks === "success" &&
    git.mergeable === true &&
    !git.isDraft &&
    reviewOk;

  // Note: the UI hides the stepper entirely when readyToMerge, and merged shows a terminal
  // chip — so the derived predicate is the only path that actually paints a filled 5th
  // segment; the manual branch stays for purity/aria of any future caller.
  if (readyToMerge || git?.state === "merged" || derivedReady) index = 4; // ready

  const terminal = git?.state === "merged" ? "merged" : git?.state === "closed" ? "closed" : null;

  // Review tint — priority: reviewing beats any stale verdict
  let review: StageInfo["review"] = "none";
  if (reviewing) {
    review = "reviewing";
  } else if (
    verdict?.decision === "changes_requested" ||
    git?.latestReview?.state === "changes_requested"
  ) {
    review = "changes";
  } else if (
    git?.latestReview?.state === "approved" ||
    (verdict?.decision === "commented" && git?.headSha != null && verdict.headSha === git.headSha)
  ) {
    review = "approved";
  } else if (verdict?.decision === "error") {
    review = "error";
  }

  return {
    reached: STAGE_ORDER[index],
    index,
    ci: git?.checks ?? "none",
    terminal,
    review,
    planningSkipped: planPhase === null,
  };
}
