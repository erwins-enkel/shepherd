import type { SessionStore } from "./store";
import { mapState, matchAgents, type HerdrDriver } from "./herdr";

export function reconcile(store: SessionStore, herdr: Pick<HerdrDriver, "list">): void {
  const sessions = store.list({ activeOnly: true });
  const matched = matchAgents(sessions, herdr.list());
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
