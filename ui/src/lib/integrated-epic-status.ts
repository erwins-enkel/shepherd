import type { CompletedEpic } from "$lib/types";

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

function landingSituation(epic: CompletedEpic, confirming: boolean): IntegratedEpicSituation {
  switch (epic.landingState) {
    case "pending":
      return "preparing";
    case "none":
      return "nothing-to-land";
    case "merged":
      return "landed";
    case "error":
      return "error";
    case "open":
      if (epic.landingRepairing) return "repairing";
      if (epic.landingRebasePauseReason || epic.landingMergeable === false) return "conflicts";
      if (epic.landingChecks === "failure") return "ci-failed";
      if (epic.landingReady === true && epic.landingPrNumber != null)
        return confirming ? "confirming" : "ready";
      if (epic.landingChecks === "success" && epic.landingMergeable === true) return "not-ready";
      return "checking";
  }
}

/** Shared display decision for the card, band order and Herd placement. The server owns merge readiness. */
export function deriveIntegratedEpicStatus(
  epic: CompletedEpic,
  confirming = false,
): IntegratedEpicStatus {
  const situation = landingSituation(epic, confirming);
  const ready = situation === "ready" || situation === "confirming";
  const done = situation === "landed";
  const quiet = situation === "preparing" || situation === "checking" || situation === "repairing";
  return {
    situation,
    turn: ready ? "ready" : done ? "done" : quiet ? "nothing-to-do" : "your-turn",
    tone: ready ? "ready" : done || quiet ? "quiet" : "warn",
    sortOrder: ready ? 0 : done ? 3 : quiet ? 2 : 1,
    needsOperator: ready || (!done && !quiet),
    canLand: ready,
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
