import { dedupeRollup, isStatusContext, mapCheckState } from "./checks";
import type { ChecksState, ClaudeShipSignal, RollupEntry } from "./types";

/**
 * Claude Ship detection (#4145). Claude Ship (Anthropic's Code Review, PR Steward and Claude
 * Approvals) posts check runs and a label through the Claude GitHub App. Its checks are review
 * gates, not CI: a failing Approvals check waits on a human, so no commit can fix it. They are
 * split off the CI rollup here and surfaced as {@link ClaudeShipSignal} instead.
 */

/** PR Steward's watch label — present while Steward may push to the PR. */
const CLAUDE_SHIP_STEWARD_LABEL = "claude-pr-steward-watching";

/** Exact Claude App check-run names → their {@link ClaudeShipChecks} field. */
const CLAUDE_CHECKS: ReadonlyMap<string, keyof ClaudeShipChecks> = new Map([
  ["Claude Code Review", "codeReview"],
  ["Claude Approvals", "approvals"],
]);

export type ClaudeShipChecks = Pick<ClaudeShipSignal, "codeReview" | "approvals">;

/** Which Claude check `name` is, or null. `isAppRun` = the run is not a GitHub Actions job, so a
 *  repo workflow that happens to be named "Claude Code Review" (claude-code-action's example
 *  workflow is) stays CI. */
export function claudeShipCheckKind(
  name: string | null | undefined,
  isAppRun: boolean,
): keyof ClaudeShipChecks | null {
  return isAppRun && name ? (CLAUDE_CHECKS.get(name) ?? null) : null;
}

/** A rollup entry's Claude check kind. Only a CheckRun without a workflow is an App run. */
function entryKind(e: RollupEntry): keyof ClaudeShipChecks | null {
  return isStatusContext(e) ? null : claudeShipCheckKind(e.name, !e.workflowName);
}

/** Split `statusCheckRollup` into the CI entries and the Claude check states (latest run per
 *  check). The CI list is the input minus every Claude App run, in input order. */
export function splitClaudeShipRollup(entries: ReadonlyArray<RollupEntry>): {
  ci: RollupEntry[];
  checks: ClaudeShipChecks;
} {
  const ci = entries.filter((e) => entryKind(e) === null);
  if (ci.length === entries.length) return { ci, checks: {} };
  const checks: ClaudeShipChecks = {};
  for (const e of dedupeRollup(entries)) {
    const kind = entryKind(e);
    if (kind) checks[kind] = mapCheckState(e.status, e.conclusion);
  }
  return { ci, checks };
}

/** The PR's Claude Ship signal, or undefined when neither the label nor a Claude check is
 *  present — so a repo without Claude Ship never carries the field. */
export function claudeShipSignal(
  labels: ReadonlyArray<string> | undefined,
  checks: ClaudeShipChecks,
): ClaudeShipSignal | undefined {
  const stewardWatching = (labels ?? []).some((l) => l.toLowerCase() === CLAUDE_SHIP_STEWARD_LABEL);
  if (!stewardWatching && checks.codeReview === undefined && checks.approvals === undefined)
    return undefined;
  return { stewardWatching, ...checks };
}

/** True while the Claude Approvals check holds a merge: pending, or failing because it waits on
 *  a human. Neutral/skipped (`none`, observe mode) and success clear it. */
export function approvalsHolding(state: ChecksState | undefined): boolean {
  return state === "pending" || state === "failure";
}

/** True while a Claude check can still move without a push: Approvals holding (a human may
 *  approve on GitHub any time) or Code Review running. Check completion moves neither the PR's
 *  `updatedAt` nor the repo fingerprint, so such a PR must stay transient (fast-polled, snapshot
 *  re-read) or the train would hold a stale `approval_pending` forever. */
export function claudeShipInFlight(signal: ClaudeShipSignal | undefined): boolean {
  return approvalsHolding(signal?.approvals) || signal?.codeReview === "pending";
}

/** Field-wise equality of two Claude Ship signals (absent ≙ absent). */
export function sameClaudeShip(
  a: ClaudeShipSignal | undefined,
  b: ClaudeShipSignal | undefined,
): boolean {
  return (
    a?.stewardWatching === b?.stewardWatching &&
    a?.codeReview === b?.codeReview &&
    a?.approvals === b?.approvals
  );
}
