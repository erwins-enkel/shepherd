import type { RepoEntry } from "$lib/types";

/** How many repos to pin in the "recently worked on" shortcut group. */
export const RECENT_LIMIT = 3;

/** The top repos we've run the most agents on lately: filtered to those with a
 *  positive recentAgentCount, ranked by count desc, then most-recently-used, then
 *  name. Single source of truth for the RepoSelect pinned group AND the New Task
 *  pane's Alt+digit repo shortcuts. */
export function recentRepos(repos: RepoEntry[], limit: number = RECENT_LIMIT): RepoEntry[] {
  return repos
    .filter((r) => (r.recentAgentCount ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.recentAgentCount ?? 0) - (a.recentAgentCount ?? 0) ||
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}
