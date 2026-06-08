import type { PlanGate, Session } from "../types";

/**
 * Which plan-gate chip a session card should show, or "none" to hide it.
 * Pure state selection so it can be unit-tested without rendering.
 *
 * Priority order (the badge only renders while the session is in the plan phase):
 *  - "none":       planPhase is null (no gate active) OR planPhase is "executing"
 *                  (the gate already passed — nothing more to surface).
 *  - "reviewing":  the plan reviewer is running now — wins over any stale verdict.
 *  - "changes":    last verdict requested changes — shows the round/cap counter.
 *  - "ready":      verdict approved and still in "planning" → operator can hit Go.
 *  - "error":      reviewer errored.
 *  - "planning":   in the plan phase, no verdict yet.
 */
export type PlanGateChip =
  | { kind: "none" }
  | { kind: "reviewing" }
  | { kind: "changes"; round: number; cap: number }
  | { kind: "ready" }
  | { kind: "error" }
  | { kind: "planning" };

export function planGateChip(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
  reviewing: boolean,
): PlanGateChip {
  // Gate only lives during the plan phase; executing means it already passed.
  if (session.planPhase == null || session.planPhase === "executing") return { kind: "none" };
  if (reviewing) return { kind: "reviewing" };
  if (gate?.decision === "changes_requested") {
    return { kind: "changes", round: gate.round, cap: gate.cap };
  }
  if (gate?.approved) return { kind: "ready" };
  if (gate?.decision === "error") return { kind: "error" };
  return { kind: "planning" };
}

/** Whether the operator may release the gate (Go) for this session. */
export function canRelease(
  session: Pick<Session, "planPhase">,
  gate: PlanGate | undefined,
): boolean {
  return Boolean(gate?.approved) && session.planPhase === "planning";
}
