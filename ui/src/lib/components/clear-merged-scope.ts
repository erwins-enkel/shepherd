import type { Session } from "../types";
import { basename } from "./learnings-drawer";

/** The "decommission all merged" batch, split along the herd's repo filter. */
export interface ClearMergedScope {
  /** Merged sessions the filter shows — what the dialog's default action clears. */
  inside: Session[];
  /** Merged sessions in repos the filter hides; empty when the herd is unfiltered. */
  outside: Session[];
  /** `outside` counted per repo, largest first, for the dialog's one-line summary. */
  outsideRepos: { name: string; count: number }[];
}

/** Split the server's merged set by the herd's repo filter (empty = every repo), matching
 *  on `repoPath` exactly as the herd does, so "inside" is what the operator is looking at. */
export function scopeClearMerged(
  sessions: Session[],
  repoFilter: ReadonlySet<string>,
): ClearMergedScope {
  if (repoFilter.size === 0) return { inside: sessions, outside: [], outsideRepos: [] };
  const inside = sessions.filter((s) => repoFilter.has(s.repoPath));
  const outside = sessions.filter((s) => !repoFilter.has(s.repoPath));
  const counts = new Map<string, number>();
  for (const s of outside) counts.set(s.repoPath, (counts.get(s.repoPath) ?? 0) + 1);
  const outsideRepos = [...counts]
    .map(([repoPath, count]) => ({ name: basename(repoPath), count }))
    .sort((a, b) => b.count - a.count);
  return { inside, outside, outsideRepos };
}

/** Leftover subprocesses the given sessions would take down; an id the server didn't count is 0. */
export function sumLeftovers(sessions: Session[], leftoversById: Record<string, number>): number {
  return sessions.reduce((n, s) => n + (leftoversById[s.id] ?? 0), 0);
}
