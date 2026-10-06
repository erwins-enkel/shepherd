/**
 * Issue-list freshness signal shared by every GitHub forge instance (#2756).
 *
 * The repo fingerprint service registers itself as the provider. `GithubForge.listIssues` then
 * keeps its cached list for as long as the slug's issue content key is unchanged, instead of
 * expiring it on a timer. A slug no fingerprint covers (no provider, a repo the fingerprint can't
 * read, or a non-GitHub forge) answers null, and the caller keeps its plain TTL.
 */
export type IssuesFreshness = (slug: string) => string | null;

let provider: IssuesFreshness | null = null;

/** Install the provider, or remove it with null. */
export function setIssuesFreshness(p: IssuesFreshness | null): void {
  provider = p;
}

/** The slug's current issue content key, or null when no fingerprint covers it. */
export function issuesFreshness(slug: string, fallback: string | null = null): string | null {
  return provider ? provider(slug) : fallback;
}
