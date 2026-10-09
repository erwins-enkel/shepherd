import type { CompletedEpic, LandingCiAutomation } from "#lib/types.js";

export type IntegratedEpicSituation =
  | "preparing"
  | "checking"
  | "repairing"
  | "ci-retrying"
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
  /** #2872: the operator may start a CI-repair agent ("Fix CI failures"). */
  canRepairCi: boolean;
  repairKind: "conflicts" | "ci" | null;
  /** #2872: why a red landing is the operator's turn — automation exhausted, the agent repair is
   *  off with Auto-Drain, an agent repair already ran and CI is still red, or the forge supports
   *  neither reruns nor agent repair (non-GitHub). Null off `ci-failed`. */
  ciVariant: "exhausted" | "drain-off" | "after-repair" | "unsupported" | null;
  /** #2872: which automatic stage Shepherd is still on while `ci-retrying`; null otherwise. */
  ciRetrying: "reruns" | "repair" | null;
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
  "ci-retrying": "nothing-to-do",
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

function automationActing(a: LandingCiAutomation | undefined): boolean {
  return !!a && [a.reruns.status, a.repair.status].some((s) => s === "pending" || s === "running");
}

/** The server reruns and repairs landing CI on GitHub only (it refuses repair-ci elsewhere). */
function forgeUnsupported(epic: CompletedEpic): boolean {
  return epic.landingCiAutomation?.reruns.skipReason === "no-github";
}

function ciVariant(epic: CompletedEpic): IntegratedEpicStatus["ciVariant"] {
  if (forgeUnsupported(epic)) return "unsupported";
  const repair = epic.landingCiAutomation?.repair;
  if (repair?.status === "done") return "after-repair";
  if (repair?.skipReason === "auto-drain-off") return "drain-off";
  return "exhausted";
}

function landingSituation(epic: CompletedEpic, confirming: boolean): IntegratedEpicSituation {
  if (epic.landingState !== "open") return NON_OPEN_SITUATION[epic.landingState];
  if (epic.landingRepairing) return "repairing";
  if (epic.landingRebasePauseReason || epic.landingMergeable === false) return "conflicts";
  // #2872: red is the operator's turn only once Shepherd's automatic stages are spent; a rerun in
  // flight (checks back to pending on the same head) still reads as Shepherd retrying.
  const automation = epic.landingCiAutomation;
  if (epic.landingChecks === "failure")
    return automationActing(automation) ? "ci-retrying" : "ci-failed";
  if (epic.landingChecks === "pending" && automation?.reruns.status === "running")
    return "ci-retrying";
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
    // The server only repairs a terminally red PR — not one whose rerun is still in flight — and
    // only on GitHub.
    canRepairCi:
      (situation === "ci-failed" || situation === "ci-retrying") &&
      epic.landingChecks === "failure" &&
      !forgeUnsupported(epic),
    ciVariant: situation === "ci-failed" ? ciVariant(epic) : null,
    ciRetrying:
      situation !== "ci-retrying"
        ? null
        : epic.landingCiAutomation?.reruns.status === "pending" ||
            epic.landingCiAutomation?.reruns.status === "running"
          ? "reruns"
          : "repair",
    repairKind:
      situation !== "repairing"
        ? null
        : epic.landingMergeable === false || epic.landingRebasePauseReason === "conflict"
          ? "conflicts"
          : "ci",
  };
}
