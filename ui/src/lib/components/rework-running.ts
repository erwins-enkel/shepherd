import type { PlanGate, ReviewVerdict, Session } from "$lib/types";
import { displayStatus } from "$lib/display-status";
import { planStallStatus } from "$lib/plan-status";
import { addressStallStatus } from "$lib/review-status";

export type ReworkRunningSignals = {
  planGate?: PlanGate;
  review?: ReviewVerdict;
};

/** A display-running session counts as "actively reworking" only while its auto-rework loop is
 *  live: the verdict is changes_requested, the operator has NOT dismissed/taken it over, and the
 *  loop is not stalled (a taken-over / timed-out final round drops out, but the genuine in-flight
 *  final round — planStallStatus/addressStallStatus "final" — stays). `now` drives the stall
 *  timeout, so the caller threads a reactive clock. */
export function isReworkRunning(
  session: Pick<Session, "id" | "status" | "planPhase">,
  signals: ReworkRunningSignals,
  workingBlocked: Record<string, boolean>,
  now: number,
): boolean {
  if (displayStatus(session, workingBlocked) !== "running") return false;
  const { planGate, review } = signals;
  const planRework =
    session.planPhase === "planning" &&
    planGate?.decision === "changes_requested" &&
    !planGate.dismissed &&
    planStallStatus(planGate, now) !== "stalled";
  const criticRework =
    review?.decision === "changes_requested" &&
    !review.dismissed &&
    addressStallStatus(review, now) !== "stalled";
  return planRework || criticRework;
}
