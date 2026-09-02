import type { HerdrDriver } from "./herdr";

/**
 * Boot reconcile for label-prefixed transient agents (issue #1135, deduped in #1093).
 *
 * This is ONE of four distinct teardown mechanisms across the transient-agent fleet, and the only
 * one whose body was byte-identical across consumers (distiller / optimizer / merge-suggest) — so
 * it was deduped here. The OTHER consumers reconcile via a different lifecycle, and forcing them
 * onto this label-prefix scan would be wrong where they already have it —
 *   - persisted `reviewer_spawns` rows → adoptOrphans/reapOrphans (plan-gate / review / doc-agent);
 *   - store `generating` state → reapGenerating (recap).
 * #1093 delivers the argv consolidation across all 10 plus this reaper dedup; a universal
 * "reap every kind" base remains out of scope.
 *
 * **The exception: synchronous block-and-clean helpers — start→poll→stop in a `finally`, random
 * temp dirs (`name ` / `autopilot ` / `verify api key`).** #1093 left these unreaped on the
 * premise that the `finally` leaves no husk. That holds only on a CLEAN exit: a server restart
 * mid-poll skips the `finally`, orphaning an interactive `claude` that idles at the prompt forever
 * (the husk-only reaper spares it as a live non-shell proc). #1136 closes that gap by calling this
 * same reaper for those three labels at boot with an EMPTY owned set — they track no inflight and
 * none is running at the synchronous boot point, so every match is a prior-lifetime orphan. The
 * standalone PR critic (`pr-critic `) — memory-only `inFlight`, no row/state reconcile — likewise
 * gains an owned-set-gated boot reap here (#1136).
 *
 * Why this mechanism exists: `inflight` is memory-only, so a server restart loses tracking of live
 * runs; the spawned interactive `claude` idles at the prompt forever after writing its output
 * (agent_status "done" = finished-turn, pane alive), and the husk-only tab reaper spares it as an
 * alive (non-shell) `claude`. So we scan herdr once at boot for TABS whose label starts with the
 * label prefix and are NOT owned by a current-process inflight run, and close them.
 * Label-based — no persisted state; the prefix's underscores (or spaces) can't appear in a real
 * session slug.
 *
 * **The scan reads TAB labels, not agent names (#2029).** herdr 0.7.5 emits no `name` on agent
 * records at all — its `--agent` label surfaces under `agent`, and only for externally-registered
 * spawns — so `a.name.startsWith(prefix)` matched nothing, forever, on every 0.7.5 host. The tab
 * label is the surviving surface (`tab create --label` is given the raw helper label, and the
 * generated schema marks it required).
 *
 * Two consequences of the re-keying, both intended:
 *  - the scan now also covers helper HUSKS (a tab whose agent already exited is absent from
 *    `agent list` but still in `tab list`), so a restart clears prior-lifetime husks at once
 *    instead of waiting for the debounced hourly sweep;
 *  - `ownedTerminalIds` is mapped to tab ids through `list()`, and that lookup is skipped
 *    entirely for an EMPTY owned set — which is every call site, since all of them run from
 *    `deferredStarts` at boot, before this process has spawned anything.
 *
 * herdr may be unavailable at boot — the scan is best-effort and no-ops on error. A `list()`
 * failure while an owned set exists is fail-closed (close nothing): without the mapping we cannot
 * tell an owned live run from an orphan.
 *
 * @param ownedTerminalIds terminalIds of THIS process's live runs, which must be spared.
 * @param logTag a short bracketed tag for log lines, e.g. "[distill]".
 */
export async function reapTransientByLabel(
  herdr: Pick<HerdrDriver, "list" | "tabsAsync" | "closeTab">,
  labelPrefix: string,
  ownedTerminalIds: Set<string>,
  logTag: string,
): Promise<void> {
  let reaped = 0;
  try {
    const candidates = (await herdr.tabsAsync()).filter((t) => t.label.startsWith(labelPrefix));
    if (candidates.length === 0) return;
    const ownedTabIds = new Set(
      ownedTerminalIds.size === 0
        ? []
        : herdr
            .list()
            .filter((a) => ownedTerminalIds.has(a.terminalId))
            .map((a) => a.tabId),
    );
    for (const t of candidates) {
      if (ownedTabIds.has(t.tabId)) continue; // spare a live run started by THIS process
      await herdr.closeTab(t.tabId);
      reaped++;
    }
  } catch (err) {
    console.warn(`${logTag} reapOrphans:`, err); // herdr may be unavailable at boot — no-op
  }
  if (reaped > 0) console.warn(`${logTag} reapOrphans: closed ${reaped} orphan tab(s)`);
}
