/** True when a PR was opened by Dependabot. `gh` reports the bot's login as
 *  `app/dependabot` (the `--json author` form) or `dependabot[bot]`. Match those
 *  exact forms rather than a substring — `includes("dependabot")` would also
 *  catch human/vanity logins like `dependabot-fan`, offering a no-op action. */
export function isDependabotAuthor(author: string): boolean {
  const login = author.toLowerCase().replace(/^app\//, "");
  return login === "dependabot" || login === "dependabot[bot]";
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
