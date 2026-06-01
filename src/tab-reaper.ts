import type { HerdrDriver } from "./herdr";
import { PROBE_NAME } from "./usage-probe";

export type ReapableHerdr = Pick<HerdrDriver, "list" | "tabs" | "closeTab">;

/** Labels shepherd authors for its short-lived helper agents. A tab with one of these
 *  labels but no live agent is an orphaned husk (the probe/critic ended without its tab
 *  being closed — e.g. a shepherd restart cleared the in-memory tracking).
 *
 *  Both markers are collision-proof against user sessions, whose labels are prompt-derived
 *  `[a-z0-9-]` slugs: {@link PROBE_NAME} contains underscores, and a "review " prefix contains
 *  a space — neither is producible by a slug. (Reaping by a bare slug like "usage-probe" would
 *  be unsafe — a user prompt can slug to exactly that.) */
function isShepherdHelperLabel(label: string): boolean {
  return label === PROBE_NAME || label.startsWith("review ");
}

/** herdr tab ids are "workspace:N" with N a positional index. */
function tabNumber(tabId: string): number {
  const n = Number.parseInt(tabId.split(":").at(-1) ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reconciliation sweep: close any usage-probe / review helper tab that no live agent
 * backs. The teardown paths (herdr.stop / start rollback) stop most leaks at the source;
 * this is the durable safety net for husks they can't reach — agents that crashed out of
 * `agent list`, or anything orphaned across a shepherd restart (which clears in-memory
 * review tracking). Returns the ids it closed.
 *
 * Safe against false positives: `herdr.start()` is synchronous and fully registers the
 * agent in `agent list` before yielding the event loop, so a labeled tab with no backing
 * agent is unambiguously dead — never a mid-start probe/review.
 *
 * Closes highest tab-number first: herdr re-densifies tab numbers when a tab closes, so
 * descending order guarantees each remaining target id stays valid (only already-closed,
 * higher-numbered tabs shift).
 */
export function reapOrphanTabs(herdr: ReapableHerdr): string[] {
  const liveTabIds = new Set(
    herdr
      .list()
      .map((a) => a.tabId)
      .filter(Boolean),
  );
  const orphans = herdr
    .tabs()
    .filter((t) => isShepherdHelperLabel(t.label) && !liveTabIds.has(t.tabId))
    .sort((a, b) => tabNumber(b.tabId) - tabNumber(a.tabId));
  for (const t of orphans) herdr.closeTab(t.tabId);
  return orphans.map((t) => t.tabId);
}
