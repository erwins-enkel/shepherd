import type { PlanGate, Session } from "../types";

/**
 * Which plan-gate chip a session card should show, or "none" to hide it.
 * Pure state selection so it can be unit-tested without rendering.
 *
 * Priority order:
 *  - "none":       planPhase is null (no gate active), OR planPhase is "executing"
 *                  with no persisted gate (nothing to show).
 *  - "view":       planPhase is "executing" AND a persisted gate exists — surfaces
 *                  the signed-off plan read-only so the operator can re-open it
 *                  during execution (issue #809). No Go/Review actions are shown.
 *  - "reviewing":  the plan reviewer is running now — wins over any stale verdict.
 *  - "changes":    last verdict requested changes — shows the round/cap counter.
 *  - "ready":      verdict approved and still in "planning" → operator can hit Go.
 *  - "error":      reviewer errored.
 *  - "planning":   in the plan phase, no verdict yet.
 */
export type PlanGateChip =
  | { kind: "none" }
  | { kind: "view" }
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
  if (session.planPhase == null) return { kind: "none" };
  // Executing: the gate already passed — surface the signed-off plan read-only (issue #809),
  // but only while a persisted gate still exists.
  if (session.planPhase === "executing") return gate ? { kind: "view" } : { kind: "none" };
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
