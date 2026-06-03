import type { GitState, ReviewVerdict, ChecksState } from "$lib/types";

/** Pipeline stages, low→high. The agent's furthest-reached stage drives the stepper. */
export const STAGE_ORDER = ["coding", "pr", "ci", "review", "ready"] as const;
export type Stage = (typeof STAGE_ORDER)[number];

export interface StageInfo {
  /** Highest stage reached. */
  reached: Stage;
  /** 0..4 — index of `reached` in STAGE_ORDER. */
  index: number;
  /** CI rollup, for tinting the CI segment ("none" when no PR). */
  ci: ChecksState;
  /** PR merged/closed → row shows a terminal chip, not the stepper. */
  terminal: "merged" | "closed" | null;
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
}): StageInfo {
  const { git, verdict, reviewing, readyToMerge } = input;
  let index = 0; // coding (branch may exist, no PR yet)
  if (git?.state === "open") {
    index = 1; // pr
    if (git.checks !== "none") index = 2; // ci
  }
  if (reviewing || verdict || git?.latestReview) index = Math.max(index, 3); // review
  if (readyToMerge || git?.state === "merged") index = 4; // ready

  const terminal = git?.state === "merged" ? "merged" : git?.state === "closed" ? "closed" : null;

  return {
    reached: STAGE_ORDER[index],
    index,
    ci: git?.checks ?? "none",
    terminal,
  };
}
