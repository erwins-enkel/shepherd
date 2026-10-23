import type { DrainStatus } from "#lib/types.js";

/** An epic child as the git rail sees it (#2735): its epic and the branch its PR merges into. */
export interface RailEpicChild {
  epic: number;
  branch: string;
}

/** The epic run the rail marks as not integrating: the paused leader when one leads, else the
 *  child's own (stopped) epic. */
export interface RailEpicStopped {
  epic: number;
  paused: boolean;
}

/** The child's epic: its persisted stamp, else (legacy row) the `epic/<#>-…` base branch. Mirrors
 *  the server's `sessionEpicParent` (src/epic-branch.ts). */
export function railEpicChild(epicParent: number | null, baseBranch: string): RailEpicChild | null {
  const fromBranch = /^epic\/(\d+)(-[a-z0-9-]+)?$/.exec(baseBranch);
  const epic = epicParent ?? (fromBranch ? Number(fromBranch[1]) : null);
  return epic == null ? null : { epic, branch: baseBranch };
}

/** Null while the repo drain acts (it integrates the child). A repo missing from the drain status
 *  has nothing leading and label-drain off, so it counts as stopped. A not-enabled drain with a
 *  leading epic means that leader is paused. */
export function railEpicStopped(
  child: RailEpicChild | null,
  drain: DrainStatus | null,
): RailEpicStopped | null {
  if (!child || drain?.enabled) return null;
  const lead = drain?.runSummary?.leadingEpic ?? null;
  return lead != null ? { epic: lead, paused: true } : { epic: child.epic, paused: false };
}
