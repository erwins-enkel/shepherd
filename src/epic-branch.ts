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
 *  produced by {@link epicIntegrationBranch}. A test on a branch NAME — use it for a PR's HEAD
 *  ref (is this the epic's aggregate landing PR?). To ask whether a SESSION is an epic child, use
 *  {@link isEpicChild}: the name of a base branch is a heuristic, not identity. */
export function isEpicIntegrationBranch(branch: string): boolean {
  return /^epic\/\d+(-[a-z0-9-]+)?$/.test(branch);
}

/** The facts {@link isEpicChild} answers from. Structural, not `Session`, so the standalone PR
 *  critic — which holds a PR and no session — can supply the same two fields. */
export interface EpicChildFacts {
  /** `Session.epicParent`: the epic parent issue number stamped at spawn. Null/absent = unknown
   *  (a non-epic session, OR a legacy row written before the field existed). */
  epicParent?: number | null;
  /** The base branch to fall back on when `epicParent` is unknown. */
  baseBranch: string;
}

/** Whether this session is ONE CHILD of a draining epic — the identity that keeps it off the merge
 *  train and routes its retire to a squash-merge into the integration branch.
 *
 *  Answered from the persisted `epicParent` fact, NOT from the shape of the base branch name: a
 *  child stacked onto a predecessor's branch is still a child, and every site that re-derived this
 *  from `isEpicIntegrationBranch(baseBranch)` would silently answer "no" for it (merging it into
 *  the wrong branch, or stalling its epic with no operator signal).
 *
 *  The branch-name test survives ONLY as the legacy fallback: rows written before the field existed
 *  carry a null stamp, so an epic already in flight across the deploy keeps working. That fallback
 *  lives here and nowhere else — a call site that re-derived it could forget it. Note the fallback
 *  can only ADD childness, never remove it: a stamped child always reads true. */
export function isEpicChild(facts: EpicChildFacts): boolean {
  return facts.epicParent != null || isEpicIntegrationBranch(facts.baseBranch);
}

/** True iff `branch` references `parentNumber` as a digit-bounded token — the number
 *  appears with a non-digit (or string edge) on both sides. Used by divergence detection
 *  (#645) to decide whether a stray `epic/*` branch belongs to this epic, catching BOTH
 *  the canonical `epic/<#>-<slug>` and a hand-named `epic/<slug>-<#>` while rejecting
 *  numeric superstrings (`1327`, `3270`). Out of scope: a rogue epic branch that doesn't
 *  carry the parent number at all. */
export function branchReferencesEpic(branch: string, parentNumber: number): boolean {
  return new RegExp(`(?:^|[^0-9])${parentNumber}(?:[^0-9]|$)`).test(branch);
}
