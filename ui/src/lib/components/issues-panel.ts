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
 * Matches a `blocked` word at a word boundary, case-insensitive — e.g. `blocked`,
 * `blocked-upstream`, `status/blocked`, `S: blocked`, `kind:blocked`. Does NOT match
 * `unblocked`/`unblock-me` (no boundary before "blocked" there). No `g` flag: `.test()`
 * stays stateless, so the shared instance is safe to reuse across calls.
 */
const BLOCKED_LABEL_RE = /\bblocked/i;

/**
 * Whether an issue's labels mark it blocked (any label matching {@link BLOCKED_LABEL_RE}).
 * The `?? []` guard tolerates a stale payload that predates the `labels` field.
 */
export function isBlocked(labels: readonly string[]): boolean {
  return (labels ?? []).some((l) => BLOCKED_LABEL_RE.test(l));
}

/**
 * Narrow an issue list to hide "blocked" issues (labeled with a blocked-word label —
 * see {@link isBlocked}). Fails open — returns every issue unchanged — when `on` is false.
 */
export function hideBlockedIssues(issues: readonly Issue[], on: boolean): Issue[] {
  if (!on) return [...issues];
  return issues.filter((issue) => !isBlocked(issue.labels));
}

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
 * Distinct author logins present in an issue list, sorted case-insensitively.
 * Issues without an author (forges/paths that don't supply one) contribute nothing.
 * Source for the author filter's radio options — computed from the RAW list so
 * picking one author doesn't make the others vanish from the picker.
 */
export function distinctAuthors(issues: readonly Issue[]): string[] {
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.author) seen.add(issue.author);
  }
  return [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Distinct label names present in an issue list, sorted case-insensitively, EXCLUDING
 * the `shepherd:active` system label (the dedicated "hide in progress" toggle already
 * governs it, so it doesn't belong in the categorization picker). Source for the label
 * filter's toggle chips — computed from the RAW list for the same reason as
 * {@link distinctAuthors}.
 *
 * `opts.excludeBlocked` additionally skips any blocked-word label (per {@link isBlocked}) —
 * the dedicated "hide blocked" toggle already governs those. Default false: unchanged
 * behaviour for existing callers.
 */
export function distinctLabels(
  issues: readonly Issue[],
  opts?: { excludeBlocked?: boolean },
): string[] {
  const excludeBlocked = opts?.excludeBlocked ?? false;
  const seen = new Set<string>();
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      if (label === ACTIVE_LABEL) continue;
      if (excludeBlocked && isBlocked([label])) continue;
      seen.add(label);
    }
  }
  return [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Merge every issue's `labelColors` into one name → hex map, for the filter popover
 * (which lists distinct label names across the whole backlog and wants a color per
 * name, not per issue). Simple last-wins merge; issues without `labelColors` (forge
 * didn't supply them, or a stale payload predating the field) contribute nothing.
 */
export function labelColorMap(issues: readonly Issue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of issues) {
    if (!issue.labelColors) continue;
    for (const [name, hex] of Object.entries(issue.labelColors)) {
      map[name] = hex;
    }
  }
  return map;
}

/**
 * Narrow an issue list to a single author. Keeps issues whose `author` equals the
 * selected login; a `null` selection is an identity filter (no author chosen). An issue
 * with no author is dropped when a specific author is selected — correct, since it can't
 * match. The `?? []`-free comparison is safe: `author` is a scalar, absent → undefined.
 */
export function filterByAuthor(issues: readonly Issue[], author: string | null): Issue[] {
  if (author == null) return [...issues];
  return issues.filter((issue) => issue.author === author);
}

/**
 * Narrow an issue list to those carrying ALL selected labels (AND semantics, mirroring
 * GitHub's multi-label filtering). An empty selection is an identity filter. The `?? []`
 * guard tolerates a stale payload predating the `labels` field.
 */
export function filterByLabels(issues: readonly Issue[], selected: ReadonlySet<string>): Issue[] {
  if (selected.size === 0) return [...issues];
  return issues.filter((issue) => {
    const labels = issue.labels ?? [];
    for (const want of selected) {
      if (!labels.includes(want)) return false;
    }
    return true;
  });
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
