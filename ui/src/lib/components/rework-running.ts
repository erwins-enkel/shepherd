import type { PlanGate, ReviewVerdict, Session } from "$lib/types";
import { displayStatus } from "$lib/display-status";

export type ReworkRunningSignals = {
  planGate?: Pick<PlanGate, "decision">;
  review?: Pick<ReviewVerdict, "decision">;
};

export function isReworkRunning(
  session: Pick<Session, "id" | "status" | "planPhase">,
  signals: ReworkRunningSignals,
  workingBlocked: Record<string, boolean>,
): boolean {
  if (displayStatus(session, workingBlocked) !== "running") return false;
  return (
    (session.planPhase === "planning" && signals.planGate?.decision === "changes_requested") ||
    signals.review?.decision === "changes_requested"
  );
}
