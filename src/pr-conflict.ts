import type { MergeStateStatus } from "./forge/types";

/** The PR fields both predicates read. Structural so it accepts a `PrStatus`, a `GitState`,
 *  or the merge core's flat `MergeSessionView` without adapters. */
export interface ConflictView {
  mergeable?: boolean | null;
  mergeStateStatus?: MergeStateStatus;
  isDraft?: boolean;
}

/**
 * BROAD conflict signal — drives the `pr-conflict` attention rule and the UI chip.
 *
 * The `!isDraft` guard rides the `mergeable === false` term ONLY: Gitea reports
 * `mergeable: false` for every draft (WIP-title convention, see gitea.ts's mapper and
 * PrRow.svelte's `blocked`), so reading that as a conflict would chip every Gitea draft.
 * `dirty` is unguarded because GitHub reports it for genuinely conflicting drafts too
 * (DRAFT masks BEHIND, not DIRTY) — so a conflicting GitHub draft still surfaces.
 */
export function isConflicting(pr: ConflictView): boolean {
  return pr.mergeStateStatus === "dirty" || (pr.mergeable === false && !pr.isDraft);
}

/**
 * DEFINITE conflict — gates every behavioural change (the CI-green and draft waivers, the
 * expiring dedup, the CI-fix stand-downs, the rebase decision's `conflict` flag).
 *
 * Deliberately narrower than {@link isConflicting}, and GitHub-shaped: `mapMergeable` proves
 * `false ⟺ CONFLICTING` on GitHub, but Gitea passes `pr.mergeable` through raw and folds
 * branch-protection / required-check state into it — so a red-but-perfectly-mergeable Gitea PR
 * can report `false`. Requiring `mergeStateStatus != null` keeps the `mergeable` branch
 * GitHub-only; on Gitea this predicate is always false and no waiver or stand-down fires there.
 * `unknown` is excluded because the poller treats it as unsettled (pr-poller's isTransientOpen).
 *
 * Strictly narrower than the pre-existing `mergeable === false` rebase trigger, so that path is
 * untouched.
 */
export function isDefiniteConflict(pr: ConflictView): boolean {
  return (
    pr.mergeStateStatus === "dirty" ||
    (pr.mergeable === false &&
      pr.mergeStateStatus != null &&
      pr.mergeStateStatus !== "unknown" &&
      !pr.isDraft)
  );
}
