import type { Session } from "$lib/types";

/** Split sessions into active (not ready) and ready-to-merge groups, preserving
 *  the input order within each group. The ready group renders below the active
 *  one as a parked "done" section. */
export function partitionSessions(sessions: Session[]): {
  active: Session[];
  ready: Session[];
} {
  const active: Session[] = [];
  const ready: Session[] = [];
  for (const s of sessions) (s.readyToMerge ? ready : active).push(s);
  return { active, ready };
}
