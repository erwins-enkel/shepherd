/** True when a PR was opened by Dependabot. `gh` reports the login as
 *  `app/dependabot`; the substring match also covers `dependabot[bot]`. */
export function isDependabotAuthor(author: string): boolean {
  return author.toLowerCase().includes("dependabot");
}

/** Whether to offer the one-click "@dependabot rebase" action on a backlog PR
 *  row: only for Dependabot PRs that are stuck (merge blocked by conflicts/behind,
 *  or a merge attempt just failed) and not already asked to rebase. */
export function showRebaseOffer(o: {
  author: string;
  blocked: boolean;
  failed: boolean;
  requested: boolean;
}): boolean {
  return isDependabotAuthor(o.author) && (o.blocked || o.failed) && !o.requested;
}
