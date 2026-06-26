import type { HerdrDriver } from "./herdr";

/**
 * Boot reconcile for label-prefixed transient agents (issue #1135, deduped in #1093).
 *
 * This is ONE of four distinct teardown mechanisms across the transient-agent fleet, and the only
 * one whose body was byte-identical across consumers (distiller / optimizer / merge-suggest) — so
 * only it is deduped here. The other three are deliberately NOT unified: persisted `reviewer_spawns`
 * rows (plan-gate / review / doc-agent), store `generating` state (recap / herd-digest), and
 * synchronous block-and-clean (namer / autopilot / verify-key) are genuinely different lifecycles.
 *
 * Why this mechanism exists: `inflight` is memory-only, so a server restart loses tracking of live
 * runs; the spawned interactive `claude` idles at the prompt forever after writing its output
 * (agent_status "done" = finished-turn, pane alive), and the husk-only tab reaper spares it as an
 * alive (non-shell) `claude`. So we scan herdr once at boot for agents whose name starts with the
 * label prefix and are NOT owned by a current-process inflight run, and close their tabs.
 * Name-based — no persisted state; the prefix's underscores can't appear in a real session slug.
 *
 * herdr may be unavailable at boot — the scan is best-effort and no-ops on error.
 *
 * @param ownedTerminalIds terminalIds of THIS process's live runs, which must be spared.
 * @param logTag a short bracketed tag for log lines, e.g. "[distill]".
 */
export function reapTransientByLabel(
  herdr: Pick<HerdrDriver, "list" | "closeTab">,
  labelPrefix: string,
  ownedTerminalIds: Set<string>,
  logTag: string,
): void {
  let reaped = 0;
  try {
    for (const a of herdr.list()) {
      if (!a.name.startsWith(labelPrefix)) continue;
      if (ownedTerminalIds.has(a.terminalId)) continue; // spare a live run started by THIS process
      herdr.closeTab(a.tabId);
      reaped++;
    }
  } catch (err) {
    console.warn(`${logTag} reapOrphans:`, err); // herdr may be unavailable at boot — no-op
  }
  if (reaped > 0) console.warn(`${logTag} reapOrphans: closed ${reaped} orphan tab(s)`);
}
