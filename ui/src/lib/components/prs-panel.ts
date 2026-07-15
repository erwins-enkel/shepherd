/**
 * Pure logic extracted from PrsPanel.svelte — unit-testable without a DOM.
 * Mirrors issues-panel.ts. Each `hide*` helper fails open (returns every PR
 * unchanged) when its flag is false, so a disabled filter never hides anything.
 */
import type { PullRequest } from "$lib/types";

/**
 * Narrow a PR list to hide drafts (`isDraft`). Fails open when `on` is false.
 */
export function hideDraftPrs(prs: readonly PullRequest[], on: boolean): PullRequest[] {
  if (!on) return [...prs];
  return prs.filter((pr) => !pr.isDraft);
}

/**
 * Whether a PR has merge conflicts — the exact predicate PrRow uses for its
 * "conflicts" chip: mergeable resolved to false AND not a draft. `mergeable === null`
 * (the host is still computing mergeability) is NOT a conflict.
 */
export function hasConflicts(pr: PullRequest): boolean {
  return pr.mergeable === false && !pr.isDraft;
}

/**
 * Narrow a PR list to hide PRs with merge conflicts (see {@link hasConflicts}).
 * Fails open when `on` is false.
 */
export function hideConflictPrs(prs: readonly PullRequest[], on: boolean): PullRequest[] {
  if (!on) return [...prs];
  return prs.filter((pr) => !hasConflicts(pr));
}

/**
 * Narrow a PR list to hide PRs whose CI rollup failed (`checks === "failure"`).
 * Only the terminal failure state is hidden — pending/success/none stay visible.
 * Fails open when `on` is false.
 */
export function hideFailingCiPrs(prs: readonly PullRequest[], on: boolean): PullRequest[] {
  if (!on) return [...prs];
  return prs.filter((pr) => pr.checks !== "failure");
}

/**
 * Narrow a PR list to a single author. Keeps PRs whose `author` equals the
 * selected login; a `null` selection is an identity filter (no author chosen).
 */
export function filterByAuthor(prs: readonly PullRequest[], author: string | null): PullRequest[] {
  if (author == null) return [...prs];
  return prs.filter((pr) => pr.author === author);
}

/**
 * Distinct author logins present in a PR list, deduped by exact (case-sensitive)
 * login then sorted case-insensitively — logins are case-sensitive identifiers, so
 * `Bob` and `bob` are kept as separate entries. PRs without an author contribute
 * nothing. Source for the author filter's radio options — computed from the RAW list
 * so picking one author doesn't make the others vanish from the picker.
 */
export function distinctAuthors(prs: readonly PullRequest[]): string[] {
  const seen = new Set<string>();
  for (const pr of prs) {
    if (pr.author) seen.add(pr.author);
  }
  return [...seen].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
