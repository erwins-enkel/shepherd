/**
 * Pure logic extracted from BacklogView.svelte and ProjectRow.svelte —
 * unit-testable without a DOM.
 */
import type { BacklogPayload, BacklogProject } from "$lib/types";

/**
 * Format a count for display: number as-is, null as the em-dash placeholder
 * `—` (matches `{project.openIssues ?? "—"}` in ProjectRow.svelte).
 */
export function formatCount(count: number | null): string | number {
  return count ?? "—";
}

/**
 * Returns true if the given project's path matches the pinnedPath.
 */
export function isPinned(project: BacklogProject, pinnedPath: string | null): boolean {
  return project.path === pinnedPath;
}

/**
 * The project whose items the detail pane shows, or null when nothing is
 * selected. Tab badges scope their counts to this project — not to the
 * all-repos `payload.totals`, which would mis-report a single repo's tab.
 */
export function selectedProject(
  payload: BacklogPayload,
  selectedPath: string | null,
): BacklogProject | null {
  if (selectedPath === null) return null;
  return payload.projects.find((p) => p.path === selectedPath) ?? null;
}

/**
 * Build the Issues tab label that BacklogView renders for the selected project.
 * No selection or unknown count → the bare "Issues" label (no number).
 * Mirrors: count → m.backlog_tab_issues_count, else m.backlog_tab_issues.
 */
export function issuesTabLabel(sel: BacklogProject | null): string {
  return sel && sel.openIssues !== null ? `Issues · ${sel.openIssues}` : "Issues";
}

/**
 * Build the PRs tab label for the selected project.
 * Mirrors: count → m.backlog_tab_prs_count, else m.backlog_tab_prs.
 */
export function prsTabLabel(sel: BacklogProject | null): string {
  return sel && sel.openPRs !== null ? `PRs · ${sel.openPRs}` : "PRs";
}

/**
 * The Actions tab's display state for the selected project — the single source
 * of truth for the failure > workflows-count > bare-label precedence.
 *
 * Both {@link actionsTabLabel} (plain-string, for tests) and BacklogView.svelte
 * (which maps each kind to a Paraglide message) derive from this, so the
 * ordering lives in exactly one place and the two renderings cannot drift.
 * - failure: failing default-branch CI → the red marker.
 * - count: number of workflows defined (github-only).
 * - bare: no selection / unknown count (null workflows on non-github forges).
 */
export type ActionsTabState =
  | { kind: "failing" }
  | { kind: "count"; count: number }
  | { kind: "bare" };

export function actionsTabState(sel: BacklogProject | null): ActionsTabState {
  if (sel && sel.ciStatus === "failure") return { kind: "failing" };
  if (sel && sel.workflows !== null) return { kind: "count", count: sel.workflows };
  return { kind: "bare" };
}

/**
 * Build the Actions tab label for the selected project.
 * Mirrors the message mapping in BacklogView.svelte: failure →
 * m.backlog_tab_actions_failing, count → m.backlog_tab_actions_count, else
 * m.backlog_tab_actions. Shares {@link actionsTabState} so the two stay in sync.
 */
export function actionsTabLabel(sel: BacklogProject | null): string {
  const state = actionsTabState(sel);
  switch (state.kind) {
    case "failing":
      return "Actions · failing";
    case "count":
      return `Actions · ${state.count}`;
    case "bare":
      return "Actions";
  }
}

// How many repos the "recently worked on" group at the top of the backlog list
// holds — same size as the repo picker's pinned shortcut group (RepoSelect).
export const RECENT_LIMIT = 3;

/** Repo name a row displays: path basename, falling back to slug/display —
 *  mirrors ProjectRow so the recents tie-break sorts by the visible name. */
function projectName(p: BacklogProject): string {
  return p.path.replace(/\/+$/, "").split("/").pop() || p.slug || p.display;
}

/**
 * Split the (already filtered) repo list into the "recently worked on" group
 * and the rest. Ranking criteria are identical to RepoSelect's pinned recents:
 * agents run in the recent window (desc), then most-recently-used (desc), then
 * name (asc); only repos with at least one recent agent qualify, capped at
 * {@link RECENT_LIMIT}. Unlike the picker (a transient dropdown that repeats
 * pinned rows below), this persistent list hoists the recents — `rest` keeps
 * the parent's order minus the hoisted entries, so no repo appears twice.
 *
 * The scope chips (has issues / has PRs) keep the recents group alive while
 * active — they narrow the universe but don't make the shortcut confusing.
 * An active *search* (`searching = true`) suppresses the group entirely and
 * returns a flat list, mirroring RepoSelect's behaviour: when the user is
 * hunting for a specific repo by name the shortcut group only gets in the way.
 */
export function partitionRecents(
  projects: readonly BacklogProject[],
  searching = false,
): {
  recents: BacklogProject[];
  rest: BacklogProject[];
} {
  if (searching) {
    return { recents: [], rest: [...projects] };
  }
  const recents = projects
    .filter((p) => (p.recentAgentCount ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.recentAgentCount ?? 0) - (a.recentAgentCount ?? 0) ||
        (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
        projectName(a).localeCompare(projectName(b)),
    )
    .slice(0, RECENT_LIMIT);
  const hoisted = new Set(recents.map((p) => p.path));
  return { recents, rest: projects.filter((p) => !hoisted.has(p.path)) };
}

/**
 * Effective hidden state for a repo: the client's optimistic overlay (`overrides`,
 * keyed by repo path — set when this client has toggled hide) wins; otherwise the
 * server baseline `project.hidden` from the backlog payload. The overlay-first order
 * lets a hide/unhide reflect immediately before the `backlog:update` broadcast lands.
 */
export function effectiveHidden(
  project: BacklogProject,
  overrides: Record<string, boolean>,
): boolean {
  return overrides[project.path] ?? project.hidden ?? false;
}

/**
 * Partition projects into `visible` (shown in the main list) and `hidden` (the
 * collapsible Hidden group), by {@link effectiveHidden}. Order within each group is
 * preserved from the input.
 */
export function splitHidden(
  projects: readonly BacklogProject[],
  overrides: Record<string, boolean>,
): { visible: BacklogProject[]; hidden: BacklogProject[] } {
  const visible: BacklogProject[] = [];
  const hidden: BacklogProject[] = [];
  for (const p of projects) (effectiveHidden(p, overrides) ? hidden : visible).push(p);
  return { visible, hidden };
}

/**
 * Narrow the repo list by activity and optional name search. Each active
 * predicate is AND'd together:
 * - `hasIssues` keeps only repos with open issues.
 * - `hasPRs` keeps only repos with open PRs.
 * - `query` (optional) keeps only repos whose name + display path contains the
 *   query string (case-insensitive substring, same rule as RepoSelect). An
 *   undefined or blank/whitespace-only query is the identity predicate.
 *
 * Counts fail closed: `?? 0` maps an unknown count (`null`, e.g. a non-github
 * forge or a not-yet-fetched repo) to 0, so only a count strictly `> 0`
 * satisfies a flag — `null` and `0` are both excluded.
 */
export function filterProjects(
  projects: readonly BacklogProject[],
  opts: { hasIssues: boolean; hasPRs: boolean; query?: string },
): BacklogProject[] {
  const q = opts.query?.trim().toLowerCase() ?? "";
  return projects.filter(
    (p) =>
      (!opts.hasIssues || (p.openIssues ?? 0) > 0) &&
      (!opts.hasPRs || (p.openPRs ?? 0) > 0) &&
      (q === "" || (projectName(p) + " " + p.display).toLowerCase().includes(q)),
  );
}
