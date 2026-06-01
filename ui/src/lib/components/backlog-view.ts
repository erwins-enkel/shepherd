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
 * Build the Issues tab label that BacklogView renders.
 * Mirrors: m.backlog_tab_issues_count({ count: payload.totals.openIssues })
 */
export function issuesTabLabel(payload: BacklogPayload): string {
  return `Issues · ${payload.totals.openIssues}`;
}

/**
 * Build the PRs tab label that BacklogView renders.
 * Mirrors: m.backlog_tab_prs_count({ count: payload.totals.openPRs })
 */
export function prsTabLabel(payload: BacklogPayload): string {
  return `PRs · ${payload.totals.openPRs}`;
}
