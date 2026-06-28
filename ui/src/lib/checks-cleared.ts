import type { GitState } from "./types";

/** Mirror of the server's `checksCleared` (src/checks-gate.ts): a PR's CI is "cleared" for
 *  handoff / review / merge when CI is green, OR the repo has no CI to wait on (`noCi` — a GitHub
 *  repo with zero workflows, stamped server-side) and the checks are at their terminal `"none"`.
 *  Single source of truth for the UI mirror sites (herd-partition `greenIdle`, TimePopover
 *  `handedOff`, GitRail `canReview`) so they can't drift from the server or each other. */
export function checksCleared(checks: GitState["checks"], noCi: boolean | undefined): boolean {
  return checks === "success" || (noCi === true && checks === "none");
}
