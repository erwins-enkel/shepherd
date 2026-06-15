import type { HerdrDriver } from "./herdr";
import { PROBE_NAME } from "./usage-probe";
import { DISTILL_LABEL } from "./distiller";

export type ReapableHerdr = Pick<HerdrDriver, "list" | "tabs" | "closeTab">;

/** Labels shepherd authors for its short-lived helper agents. A tab with one of these
 *  labels but no live agent is an orphaned husk (the probe/critic ended without its tab
 *  being closed — e.g. a shepherd restart cleared the in-memory tracking).
 *
 *  All markers are collision-proof against user sessions, whose labels are prompt-derived
 *  `[a-z0-9-]` slugs: {@link PROBE_NAME} and {@link DISTILL_LABEL} contain underscores, and the
 *  "review " / "name " prefixes contain a space — none is producible by a slug. (Reaping by a
 *  bare slug like "usage-probe" or "distill" would be unsafe — a user prompt can slug to exactly
 *  that.) The "name " prefix is the background LLM namer's transient tab (`name TASK-NN`). */
function isShepherdHelperLabel(label: string): boolean {
  return (
    label === PROBE_NAME ||
    label === DISTILL_LABEL ||
    label.startsWith("review ") ||
    label.startsWith("name ")
  );
}

/**
 * Parses the positional `workspace:N` index used by herdr **≤0.6**, where tab ids are
 * `"workspace:N"` with N a dense integer that re-numbers on close. Under herdr 0.7 stable
 * ids (e.g. `w1:t1`) the last `:`-segment is not numeric, so this returns `0` for every
 * tab — which is fine (see `reapOrphanTabs`). Retained until herdr 0.7 is the deployed
 * floor, at which point this helper and the `.sort()` in `reapOrphanTabs` can be removed.
 */
function tabNumber(tabId: string): number {
  const n = Number.parseInt(tabId.split(":").at(-1) ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reconciliation sweep: close any usage-probe / review / namer / distill helper tab that no
 * live agent backs. The teardown paths (herdr.stop / start rollback) stop most leaks at the source;
 * this is the durable safety net for husks they can't reach — agents that crashed out of
 * `agent list`, or anything orphaned across a shepherd restart (which clears in-memory
 * review tracking). Returns the ids it closed.
 *
 * Safe against false positives: `herdr.start()` is synchronous and fully registers the
 * agent in `agent list` before yielding the event loop, so a labeled tab with no backing
 * agent is unambiguously dead — never a mid-start probe/review.
 *
 * Closes in descending tab-number order. The behaviour under each herdr version:
 *
 * - **herdr ≤0.6** (positional ids, e.g. `workspace:N`): ids re-densify on close, so
 *   closing highest-number-first keeps each remaining snapshotted target id valid — only
 *   already-closed, higher-numbered tabs shift.
 * - **herdr 0.7** (#569, stable ids e.g. `w1:t1`): closed ids don't retarget, so close
 *   order is irrelevant. `tabNumber()` returns `0` for every 0.7 id, making the sort a
 *   harmless no-op (order-preserving on ties).
 *
 * Net: correct under both; the sort is load-bearing on 0.6.10 (still deployed) and
 * inert on 0.7.
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
