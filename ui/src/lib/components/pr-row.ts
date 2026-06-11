import type { PrKind } from "$lib/types";

/** Whether to offer the one-click "@dependabot rebase" action on a backlog PR
 *  row: only for Dependabot PRs that are stuck (merge blocked by conflicts/behind,
 *  or a merge attempt just failed) and not already asked to rebase. The PR kind
 *  is the single source of truth — the server classifies it (`src/forge/pr-kind.ts`),
 *  so the row never re-derives bot-ness from the author. */
export function showRebaseOffer(o: {
  kind: PrKind;
  blocked: boolean;
  failed: boolean;
  requested: boolean;
}): boolean {
  return o.kind === "dependabot" && (o.blocked || o.failed) && !o.requested;
}
