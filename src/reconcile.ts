import type { SessionStore } from "./store";
import { mapState, matchAgents, type HerdrDriver } from "./herdr";

export function reconcile(store: SessionStore, herdr: Pick<HerdrDriver, "list">): void {
  const sessions = store.list({ activeOnly: true });
  // herdr can be unreachable at startup (cold boot before herdr is up, or herdr was
  // just stopped — e.g. by an update). `agent list` then THROWS. This runs once at
  // top level with no surrounding try/catch, so an unhandled throw exits shepherd —
  // and with systemd Restart=on-failure that becomes a crash-loop (#315): shepherd
  // dies before its poller can bring herdr back, so it never recovers. Bail on any
  // herdr failure WITHOUT touching session state (the agents are alive; herdr is just
  // temporarily unreachable — reaping them all to "done" would be wrong). The 1s
  // poller, which already skips ticks the same way, reconciles once herdr is reachable.
  let agents: ReturnType<HerdrDriver["list"]>;
  try {
    agents = herdr.list();
  } catch (err) {
    console.warn("[reconcile] herdr list failed; skipping startup reconcile:", err);
    return;
  }
  const matched = matchAgents(sessions, agents);
  for (const s of sessions) {
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
