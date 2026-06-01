import type { Session, GitState } from "$lib/types";

/** Split sessions into active (still in play), ready-to-merge (operator-parked),
 *  and merged (PR already landed) groups, preserving the input order within each.
 *  Merged wins over ready: once the PR is in, that's the final state. The ready
 *  and merged groups render below the active one as parked "done" sections. */
export function partitionSessions(
  sessions: Session[],
  git: Record<string, GitState>,
): {
  active: Session[];
  ready: Session[];
  merged: Session[];
} {
  const active: Session[] = [];
  const ready: Session[] = [];
  const merged: Session[] = [];
  for (const s of sessions) {
    if (git[s.id]?.state === "merged") merged.push(s);
    else if (s.readyToMerge) ready.push(s);
    else active.push(s);
  }
  return { active, ready, merged };
}
