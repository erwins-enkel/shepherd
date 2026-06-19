/**
 * Pure logic extracted from IssuesPanel.svelte — unit-testable without a DOM.
 */
import type { Issue } from "$lib/types";

/**
 * Narrow an issue list by a free-text query (the panel's search field).
 * Case-insensitive substring match against number (with or without a leading
 * `#`), title, body, and labels. A blank/whitespace query is an identity
 * filter — the field starts empty and must not hide anything.
 */
export function filterIssues(issues: readonly Issue[], query: string): Issue[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...issues];
  const needle = q.startsWith("#") ? q.slice(1) : q;
  return issues.filter(
    (issue) =>
      String(issue.number).includes(needle) ||
      issue.title.toLowerCase().includes(q) ||
      issue.body.toLowerCase().includes(q) ||
      issue.labels.some((label) => label.toLowerCase().includes(q)),
  );
}

/**
 * Narrow an issue list to "mine & unassigned" (#824): keep an issue when it has
 * no assignees OR the viewer is one of its assignees; drop issues assigned only
 * to other people.
 *
 * Fails open — returns every issue unchanged — when `enabled` is false or
 * `viewer` is null (offline/unauth/local forge: we don't know who "me" is, so we
 * must never hide everything). The `?? []` guard tolerates a stale/old-shape
 * payload that predates the server's `assignees` field, so the helper can never
 * throw on a missing array.
 */
export function hideOthers(
  issues: readonly Issue[],
  viewer: string | null,
  enabled: boolean,
): Issue[] {
  if (!enabled || viewer == null) return [...issues];
  return issues.filter((issue) => {
    const assignees = issue.assignees ?? [];
    return assignees.length === 0 || assignees.includes(viewer);
  });
}
