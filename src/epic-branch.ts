/** Deterministic integration-branch name for an epic: `epic/<parent#>-<slug>`.
 *  Pure — recomputed everywhere (spawn base, retire merge target, buildEpic) so
 *  no per-epic branch name needs persisting. A title that slugs to empty degrades
 *  to the bare `epic/<parent#>`. The slug is bounded so the ref stays a sane length. */
export function epicIntegrationBranch(parentNumber: number, parentTitle: string): string {
  const slug = parentTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `epic/${parentNumber}-${slug}` : `epic/${parentNumber}`;
}

/** True when `branch` is an epic integration branch (`epic/<#>` or `epic/<#>-<slug>`) as
 *  produced by {@link epicIntegrationBranch}. The session-local marker that a drain auto
 *  session is an epic child — used to keep it off the merge train and route its retire to a
 *  squash-merge into the integration branch. */
export function isEpicIntegrationBranch(branch: string): boolean {
  return /^epic\/\d+(-[a-z0-9-]+)?$/.test(branch);
}
