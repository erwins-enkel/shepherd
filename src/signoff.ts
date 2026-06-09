import type { ReviewDecision } from "./types";

export type SignoffAuthority = "human" | "critic" | "either";

export interface SignoffView {
  /** A human submitted an APPROVED review on the PR (forge data). */
  humanApproved: boolean;
  /** The critic verdict's decision for this session, or null if no verdict yet. */
  reviewDecision: ReviewDecision | null;
  /** The critic verdict's discrete findings ([] = clean). */
  findings: string[];
  /** The PR head the critic verdict applies to, or null. */
  reviewHeadSha: string | null;
  /** The PR's current head sha, or null if unknown. */
  headSha: string | null;
}

function humanSignedOff(view: SignoffView): boolean {
  return view.humanApproved === true;
}

/**
 * Critic sign-off requires ALL of:
 * - decision === "commented" (the only non-blocking outcome; ReviewDecision has NO "approved" value)
 * - findings.length === 0 (deliberately stricter: commented-with-findings is advisory, not sign-off)
 * - reviewHeadSha === headSha (stale or unknown-head verdicts are not sign-off)
 */
function criticSignedOff(view: SignoffView): boolean {
  return (
    view.reviewDecision === "commented" &&
    view.findings.length === 0 &&
    view.reviewHeadSha !== null &&
    view.headSha !== null &&
    view.reviewHeadSha === view.headSha
  );
}

/**
 * Returns true when this PR has the required sign-off for the given authority.
 *
 * Note: ReviewDecision has NO "approved" value — human approval is tracked separately
 * via `humanApproved` (forge data), not via the critic verdict. The critic path
 * requires `decision === "commented"` (the only non-blocking outcome) AND `findings: []`
 * (advisory commented-with-findings verdicts intentionally do NOT constitute sign-off).
 */
export function signedOff(authority: SignoffAuthority, view: SignoffView): boolean {
  switch (authority) {
    case "human":
      return humanSignedOff(view);
    case "critic":
      return criticSignedOff(view);
    case "either":
      return humanSignedOff(view) || criticSignedOff(view);
  }
}
