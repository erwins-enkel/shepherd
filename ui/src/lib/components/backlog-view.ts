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
 * Build the Actions tab label for the selected project.
 * - Failing default-branch CI → "Actions · failing" (the marker; red in the UI).
 * - Otherwise: the number of workflows defined (github-only; null on other
 *   forges → bare label).
 * Mirrors: failure → m.backlog_tab_actions_failing,
 *          count → m.backlog_tab_actions_count, else m.backlog_tab_actions.
 */
export function actionsTabLabel(sel: BacklogProject | null): string {
  if (sel && sel.ciStatus === "failure") return "Actions · failing";
  return sel && sel.workflows !== null ? `Actions · ${sel.workflows}` : "Actions";
}
