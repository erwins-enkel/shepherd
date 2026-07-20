import type { MergeStateStatus } from "./types";

/** UI-side copy of the server's `isConflicting` (src/pr-conflict.ts).
 *
 *  Duplicated deliberately: `ui/` never imports from `src/` and re-declares the forge types
 *  locally (see ./types), so there is no shared module to import. Keep the two in step — the
 *  server predicate is the source of truth.
 *
 *  The `!isDraft` guard rides the `mergeable === false` term ONLY: Gitea reports
 *  `mergeable: false` for every draft (WIP-title convention), so reading that as a conflict
 *  would chip every Gitea draft. `dirty` is unguarded because GitHub reports it for genuinely
 *  conflicting drafts too (DRAFT masks BEHIND, not DIRTY).
 *
 *  Drift-locked against the server copy by test/fixtures/pr-conflict-parity.json — both suites
 *  assert the same case table, so editing one implementation alone fails the other's test. */
export function isConflicting(pr: {
  mergeable?: boolean | null;
  mergeStateStatus?: MergeStateStatus;
  isDraft?: boolean;
}): boolean {
  return pr.mergeStateStatus === "dirty" || (pr.mergeable === false && !pr.isDraft);
}
