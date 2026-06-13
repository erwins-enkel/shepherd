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
