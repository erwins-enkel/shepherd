/**
 * Pure logic extracted from IssuesPanel.svelte — unit-testable without a DOM.
 */
import type { Issue } from "$lib/types";

/**
 * Filter issues to those that have at least one label in `filterLabels` (OR
 * semantics). When `filterLabels` is empty or absent every issue is visible.
 */
export function filterIssues(issues: Issue[], filterLabels: string[] | undefined): Issue[] {
  if (!filterLabels || filterLabels.length === 0) return issues;
  return issues.filter((issue) => issue.labels.some((l) => filterLabels.includes(l)));
}

/**
 * Compute the age in whole days relative to `now` (defaults to Date.now()).
 * Returns a non-negative integer.
 */
export function issueAgeDays(createdAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - createdAt) / 86_400_000));
}
