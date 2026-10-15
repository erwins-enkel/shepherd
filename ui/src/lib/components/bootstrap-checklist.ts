import type { RepoBootstrapView } from "#lib/api.js";

/** One row of the Backlog bootstrap checklist (#3112). P1+P2 run as one session, so one row. */
export type ChecklistStepId = "scaffold" | "gaps" | "backlog" | "exit";
export type ChecklistStepState = "done" | "current" | "todo";

/** The repo phase at which each row becomes current; a row is done once the phase passes its end. */
const STEPS: { id: ChecklistStepId; from: number; until: number }[] = [
  { id: "scaffold", from: 1, until: 3 },
  { id: "gaps", from: 3, until: 4 },
  { id: "backlog", from: 4, until: 5 },
  { id: "exit", from: 5, until: 6 },
];

export function checklistSteps(
  phase: number,
): { id: ChecklistStepId; state: ChecklistStepState }[] {
  return STEPS.map(({ id, from, until }) => ({
    id,
    state: phase >= until ? "done" : phase >= from ? "current" : "todo",
  }));
}

/** The checklist's one primary action, or null when the repo is not in an active bootstrap. */
export type ChecklistAction =
  | { kind: "open-session"; sessionId: string }
  | { kind: "start-bootstrap"; phase: number }
  | { kind: "start-epic" }
  | { kind: "open-readiness" };

export function checklistAction(view: RepoBootstrapView): ChecklistAction | null {
  const next = view.next;
  if (view.state !== "active" || !next) return null;
  if (next.sessionId) return { kind: "open-session", sessionId: next.sessionId };
  if (next.kind === "bootstrap") return { kind: "start-bootstrap", phase: next.phase };
  return next.kind === "epic" ? { kind: "start-epic" } : { kind: "open-readiness" };
}
