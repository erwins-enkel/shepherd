import type { Session, GitState } from "$lib/types";
import { partitionSessions, shownSessions, type HerdFilter } from "./herd-partition";

/** Pure ordering/cycling logic for the herd's keyboard navigation (j/k, g, 1-9).
 *  Sibling of herd-partition.ts: the page-level shortcut handler computes the
 *  rail's visible order here instead of duplicating Herd.svelte's template walk. */

/** Top→bottom group order of Herd.svelte's template — MUST match the order the
 *  rail renders its stage groups in (active first, merged last). */
const RAIL_GROUP_ORDER = [
  "active",
  "ciRunning",
  "ciFailed",
  "reviewerRunning",
  "waitingOnReviewer",
  "waitingOnMerger",
  "draftAwaitingSignoff",
  "awaitingMerge",
  "merging",
  "ready",
  "merged",
] as const;

/** Session ids in the exact order the herd rail renders them: the same shown
 *  set (rail filter applied) and partition Herd.svelte derives, flattened in
 *  its template's group order. */
export function railOrder(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
  now: number = Date.now(),
  filter: HerdFilter = "all",
): string[] {
  const partition = partitionSessions(
    shownSessions(sessions, filter, isReviewing),
    git,
    isReviewing,
    now,
  );
  return RAIL_GROUP_ORDER.flatMap((group) => partition[group].map((s) => s.id));
}

/** The id one step (+1 down / -1 up) from `currentId` in `order`, wrapping at
 *  both ends. With nothing selected (or a selection not in the list) a downward
 *  step lands on the first row, an upward step on the last. Null when empty. */
export function cycleId(order: string[], currentId: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const idx = currentId ? order.indexOf(currentId) : -1;
  if (idx === -1) return step > 0 ? order[0] : order[order.length - 1];
  return order[(idx + step + order.length) % order.length];
}

/** The Nth (1-based) id in rail order, or null when out of range. */
export function nthId(order: string[], n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= order.length ? order[n - 1] : null;
}

/** Next blocked session after `currentId` in `blockedIds` (oldest-first, the
 *  NEEDS-YOU set), wrapping around; cycles among several, skips the current one.
 *  Null when none are blocked or the only blocked session is already selected. */
export function nextNeedsYou(blockedIds: string[], currentId: string | null): string | null {
  if (blockedIds.length === 0) return null;
  const idx = currentId ? blockedIds.indexOf(currentId) : -1;
  const start = idx === -1 ? 0 : idx + 1;
  for (let i = 0; i < blockedIds.length; i++) {
    const id = blockedIds[(start + i) % blockedIds.length];
    if (id !== currentId) return id;
  }
  return null;
}
