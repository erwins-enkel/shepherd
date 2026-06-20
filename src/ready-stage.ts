// DRIFT: keep in sync with ui/src/lib/components/herd-partition.ts (stageOf/shownSessions ready filter)
// + ui/src/lib/display-status.ts
// Intentional delta vs the UI: `merged` is also excluded from isReadyForNotify (terminal ≠ your turn).
import type { Session, SessionStatus } from "./types";
import type { GitState } from "./forge/types";
import { isMerging } from "./rundown-core";

/** Display-side session status — port of ui/src/lib/display-status.ts.
 *  A session herdr reports "blocked" but the server flagged as working-while-blocked
 *  renders with the full working treatment (upgrades blocked → running).
 *  The flag only ever upgrades blocked — a stale entry on a non-blocked session is inert. */
function displayStatus(
  s: Pick<Session, "id" | "status">,
  workingBlocked: Record<string, boolean>,
): SessionStatus {
  return s.status === "blocked" && workingBlocked[s.id] ? "running" : s.status;
}

/** Lifecycle stage of a session — mirrors herd-partition.ts's Stage type. */
type Stage =
  | "merged"
  | "merging"
  | "ready"
  | "reviewerRunning"
  | "ciRunning"
  | "ciFailed"
  | "draftAwaitingSignoff"
  | "waitingOnReviewer"
  | "waitingOnMerger"
  | "awaitingMerge"
  | "active";

/** Terminal / in-flight stages that win before the green-idle handoff decision, or null
 *  when none apply. Port of herd-partition.ts's terminalStage. */
function terminalStage(
  s: Session,
  g: GitState | undefined,
  isReviewing: (id: string) => boolean,
  now: number,
): Stage | null {
  if (g?.state === "merged") return "merged";
  if (isMerging(s, now)) return "merging";
  if (s.readyToMerge) return "ready";
  if (isReviewing(s.id)) return "reviewerRunning";
  if (g?.state === "open" && g.checks === "pending") return "ciRunning";
  if (g?.state === "open" && g.checks === "failure") return "ciFailed";
  return null;
}

/** Bucket a green, idle (handed-off) PR. Port of herd-partition.ts's handoffStage. */
function handoffStage(g: GitState): Stage {
  if (g.isDraft) return "draftAwaitingSignoff";
  if (g.handoff === "reviewer") return "waitingOnReviewer";
  if (g.handoff === "merger") return "waitingOnMerger";
  return "awaitingMerge";
}

/** Classify one session into its lifecycle stage (first-match precedence).
 *  Port of herd-partition.ts's stageOf.
 *  Precedence: merged > merging > ready > reviewerRunning > ciRunning > ciFailed >
 *  (greenIdle → draftAwaitingSignoff | waitingOnReviewer | waitingOnMerger | awaitingMerge) > active. */
function stageOf(
  s: Session,
  g: GitState | undefined,
  isReviewing: (id: string) => boolean,
  now: number,
): Stage {
  const terminal = terminalStage(s, g, isReviewing, now);
  if (terminal) return terminal;
  // Raw status by design: a working-while-blocked session (display "running") is raw
  // "blocked" — both are excluded from greenIdle, so the display flag can't change
  // the partition and doesn't need threading through here.
  const greenIdle =
    g?.state === "open" &&
    g.checks === "success" &&
    s.status !== "running" &&
    s.status !== "blocked";
  return greenIdle ? handoffStage(g) : "active";
}

/** Stages the "ready" lens hides — the session is NOT awaiting the operator.
 *  Delta from NOT_YOUR_TURN in herd-partition.ts: also excludes `merged`
 *  (terminal ≠ your turn) for the push-notification evaluator. */
const NOT_NOTIFY: ReadonlySet<Stage> = new Set([
  "ciRunning",
  "waitingOnReviewer",
  "waitingOnMerger",
  "merging",
  "merged", // intentional delta: terminal stage excluded from push notify
]);

/** Ready-for-notify predicate. Equivalent to the UI's shownSessions(filter="ready") filter:
 *  displayStatus !== "running" && !isReviewing(s.id) && stage ∉ NOT_NOTIFY.
 *  Intentional delta vs the UI's NOT_YOUR_TURN: also excludes `merged`. */
export function isReadyForNotify(
  s: Session,
  git: GitState | undefined,
  isReviewing: (id: string) => boolean,
  workingBlocked: Record<string, boolean>,
  now: number,
): boolean {
  if (displayStatus(s, workingBlocked) === "running") return false;
  if (isReviewing(s.id)) return false;
  const stage = stageOf(s, git, isReviewing, now);
  return !NOT_NOTIFY.has(stage);
}
