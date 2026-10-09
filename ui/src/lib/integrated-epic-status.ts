import type { CompletedEpic } from "#lib/types.js";

export type IntegratedEpicSituation =
  | "preparing"
  | "checking"
  | "repairing"
  | "ci-failed"
  | "conflicts"
  | "nothing-to-land"
  | "ready"
  | "confirming"
  | "landed"
  | "error"
  | "not-ready";

export interface IntegratedEpicStatus {
  situation: IntegratedEpicSituation;
  turn: "nothing-to-do" | "your-turn" | "ready" | "done";
  tone: "quiet" | "warn" | "ready";
  sortOrder: 0 | 1 | 2 | 3;
  needsOperator: boolean;
  canLand: boolean;
  canResolveConflicts: boolean;
  repairKind: "conflicts" | "ci" | null;
}

const NON_OPEN_SITUATION = {
  pending: "preparing",
  none: "nothing-to-land",
  merged: "landed",
  error: "error",
} as const;

const SITUATION_TURN: Record<IntegratedEpicSituation, IntegratedEpicStatus["turn"]> = {
  preparing: "nothing-to-do",
  checking: "nothing-to-do",
  repairing: "nothing-to-do",
  "ci-failed": "your-turn",
  conflicts: "your-turn",
  "nothing-to-land": "your-turn",
  error: "your-turn",
  "not-ready": "your-turn",
  ready: "ready",
  confirming: "ready",
  landed: "done",
};
const TURN_POLICY: Record<
  IntegratedEpicStatus["turn"],
  Pick<IntegratedEpicStatus, "tone" | "sortOrder" | "needsOperator" | "canLand">
> = {
  "nothing-to-do": { tone: "quiet", sortOrder: 2, needsOperator: false, canLand: false },
  "your-turn": { tone: "warn", sortOrder: 1, needsOperator: true, canLand: false },
  ready: { tone: "ready", sortOrder: 0, needsOperator: true, canLand: true },
  done: { tone: "quiet", sortOrder: 3, needsOperator: false, canLand: false },
};

function landingSituation(epic: CompletedEpic, confirming: boolean): IntegratedEpicSituation {
  if (epic.landingState !== "open") return NON_OPEN_SITUATION[epic.landingState];
  if (epic.landingRepairing) return "repairing";
  if (epic.landingRebasePauseReason || epic.landingMergeable === false) return "conflicts";
  if (epic.landingChecks === "failure") return "ci-failed";
  if (epic.landingReady === true && epic.landingPrNumber != null)
    return confirming ? "confirming" : "ready";
  if (epic.landingChecks === "success" && epic.landingMergeable === true) return "not-ready";
  return "checking";
}

/** Shared display decision for the card, band order and Herd placement. The server owns merge readiness. */
export function deriveIntegratedEpicStatus(
  epic: CompletedEpic,
  confirming = false,
): IntegratedEpicStatus {
  const situation = landingSituation(epic, confirming);
  const turn = SITUATION_TURN[situation];
  return {
    situation,
    turn,
    ...TURN_POLICY[turn],
    canResolveConflicts:
      epic.landingState === "open" &&
      !epic.landingRepairing &&
      (epic.landingRebasePauseReason === "conflict" || epic.landingMergeable === false),
    repairKind:
      situation !== "repairing"
        ? null
        : epic.landingMergeable === false || epic.landingRebasePauseReason === "conflict"
          ? "conflicts"
          : "ci",
  };
}
