import type { Session, GitState } from "#lib/types.js";
import { displayStatus } from "#lib/display-status.js";
import { isMergeStage } from "./herd-partition";

/** The four global herd statuses the top-bar tallies count and the status filter picks. They
 *  never overlap: Merge is carved out of the resting sessions, so Idle excludes it. */
export type HerdStatus = "running" | "idle" | "blocked" | "merge";

/** Top-bar order — also the order of a repo heading's counts. */
export const HERD_STATUS_ORDER = [
  "running",
  "idle",
  "blocked",
  "merge",
] as const satisfies readonly HerdStatus[];

/** What classifying a session needs beyond the session itself. `git`, `workingBlocked` and
 *  `backgroundBusy` are this Shepherd's store maps; a mirrored session (#3055) reads its own
 *  `s.git` and no display flags instead. */
export type HerdStatusCtx = {
  git: Record<string, GitState>;
  isReviewing: (id: string) => boolean;
  isReworkRunning: (session: Session) => boolean;
  workingBlocked: Record<string, boolean>;
  backgroundBusy: Record<string, boolean>;
  now: number;
};

const NO_FLAGS: Record<string, boolean> = {};

/** The session's global status, or null when no tally counts it:
 *  - running: display status running (a shelved session too — it is still working)
 *  - blocked: display status blocked
 *  - merge: resting (idle, or herdr's finished-turn `done`) on a green PR waiting for the
 *    operator's merge (stage awaitingMerge / ready)
 *  - idle: display status idle and not Merge
 *  Shelved sessions count only while running; a resting `done` session without a Merge stage
 *  counts nowhere (as before Merge existed). */
export function herdStatusOf(s: Session, ctx: HerdStatusCtx): HerdStatus | null {
  const mirrored = s.host != null;
  const status = mirrored
    ? displayStatus(s, NO_FLAGS, NO_FLAGS)
    : displayStatus(s, ctx.workingBlocked, ctx.backgroundBusy);
  if (status === "running") return "running";
  if (s.shelved) return null;
  if (status === "blocked") return "blocked";
  if (status !== "idle" && status !== "done") return null;
  const g = mirrored ? s.git : ctx.git[s.id];
  if (isMergeStage(s, g, ctx.isReviewing, ctx.isReworkRunning, ctx.now)) return "merge";
  return status === "idle" ? "idle" : null;
}

export function countHerdStatuses(
  sessions: readonly Session[],
  ctx: HerdStatusCtx,
): Record<HerdStatus, number> {
  const counts: Record<HerdStatus, number> = { running: 0, idle: 0, blocked: 0, merge: 0 };
  for (const s of sessions) {
    const status = herdStatusOf(s, ctx);
    if (status) counts[status]++;
  }
  return counts;
}
