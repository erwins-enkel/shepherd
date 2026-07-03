/**
 * Pure logic extracted from IssuesPanel.svelte — unit-testable without a DOM.
 */
import type { Issue } from "$lib/types";

/**
 * Label the drain stamps on an issue claimed by a running session (mirrors
 * ACTIVE_LABEL in src/drain-core.ts). Canonical UI-side source — imported by
 * PromptSources.svelte and IssuesPanel.svelte instead of a bare literal.
 */
export const ACTIVE_LABEL = "shepherd:active";

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

/**
 * Narrow an issue list to "hide in progress": drop issues already claimed by a
 * running session (labeled `shepherd:active`). Viewer-agnostic — it keys off a
 * label, not assignees.
 *
 * Fails open — returns every issue unchanged — when `enabled` is false. The
 * `?? []` guard tolerates a stale payload that predates the `labels` field, so
 * the helper can never throw on a missing array.
 */
export function hideActive(issues: readonly Issue[], enabled: boolean): Issue[] {
  if (!enabled) return [...issues];
  return issues.filter((issue) => !(issue.labels ?? []).includes(ACTIVE_LABEL));
}

/**
 * Narrow an issue list to hide native sub-issues (children of a GitHub epic),
 * nudging the operator to start an epic drain instead of draining a child alone.
 *
 * Hides an issue only when it is a native sub-issue (`subIssues.has(number)`) AND
 * not itself an epic parent (`!epicParents.has(number)`) — so a mid-level epic
 * (a sub-issue that is also a parent) stays visible as a drain entry point.
 *
 * Fails open — returns every issue unchanged — when `enabled` is false or
 * `subIssues` is empty (non-GitHub forge / drain-absent / epics not yet loaded).
 */
export function hideSubIssues(
  issues: readonly Issue[],
  enabled: boolean,
  subIssues: ReadonlySet<number>,
  epicParents: ReadonlySet<number>,
): Issue[] {
  if (!enabled) return [...issues];
  return issues.filter((issue) => !(subIssues.has(issue.number) && !epicParents.has(issue.number)));
}

/**
 * Reorder an issue list so epic parents (issues whose number is in `epicParents`)
 * come first, followed by everything else. Stable — the relative order within
 * each group is preserved (so the forge's newest-first ordering survives inside
 * both groups). Returns a new array; the input is not mutated.
 *
 * A no-op (identity copy) when there are no epic parents in the list.
 */
export function sortEpicsFirst(
  issues: readonly Issue[],
  epicParents: ReadonlySet<number>,
): Issue[] {
  const epics: Issue[] = [];
  const rest: Issue[] = [];
  for (const issue of issues) {
    (epicParents.has(issue.number) ? epics : rest).push(issue);
  }
  return [...epics, ...rest];
}
