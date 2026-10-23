import type { SessionStore } from "./store";
import {
  mapState,
  matchAgents,
  withLazyTabLabels,
  type HerdrAgent,
  type HerdrDriver,
} from "./herdr";

/**
 * `tabs` is optional and read LAZILY — only when two still-unmatched sessions share a worktree and
 * `matchAgents` has to disambiguate them by name. That branch is the one this startup pass exists
 * for (a herdr daemon restart invalidates every terminalId), and on 0.7.5 it is also the branch
 * that cannot work off `agent.name`, which herdr no longer sends (#2029). A failing tab read
 * degrades to "no name evidence" — the pre-existing behaviour — never to a wrong pairing.
 */
export async function reconcile(
  store: SessionStore,
  herdr: Pick<HerdrDriver, "listAsync"> & Partial<Pick<HerdrDriver, "tabsAsync">>,
): Promise<void> {
  // Snapshot sessions BEFORE the list: one created while herdr is answering is absent from
  // `agents` and must not be reaped to `done` the moment it spawned.
  const sessions = store.list({ activeOnly: true });
  // herdr can be unreachable at startup (cold boot before herdr is up, or herdr was
  // just stopped — e.g. by an update). `agent list` then THROWS. This runs once at
  // startup with no caller awaiting it, so an unhandled rejection exits shepherd —
  // and with systemd Restart=on-failure that becomes a crash-loop (#315): shepherd
  // dies before its poller can bring herdr back, so it never recovers. Bail on any
  // herdr failure WITHOUT touching session state (the agents are alive; herdr is just
  // temporarily unreachable — reaping them all to "done" would be wrong). The 1s
  // poller, which already skips ticks the same way, reconciles once herdr is reachable.
  let agents: HerdrAgent[];
  try {
    agents = await herdr.listAsync();
  } catch (err) {
    console.warn("[reconcile] herdr list failed; skipping startup reconcile:", err);
    return;
  }
  const matched = herdr.tabsAsync
    ? await withLazyTabLabels({ tabsAsync: herdr.tabsAsync.bind(herdr) }, (labels) =>
        matchAgents(sessions, agents, labels),
      )
    : matchAgents(sessions, agents);
  for (const s of sessions) {
    if (store.get(s.id)?.status === "archived") continue; // archived while herdr was listed
    const agent = matched.get(s.id) ?? null;
    if (!agent) store.update(s.id, { status: "done", lastState: "done" });
    else
      store.update(s.id, {
        status: mapState(agent.agentStatus),
        lastState: agent.agentStatus,
        herdrAgentId: agent.terminalId, // re-point if the daemon reassigned it (no-op when same)
      });
  }
}
