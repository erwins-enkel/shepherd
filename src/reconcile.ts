import type { SessionStore } from "./store";
import { mapState, matchAgent, type HerdrDriver, type HerdrAgent } from "./herdr";

export function reconcile(store: SessionStore, herdr: Pick<HerdrDriver, "list">): void {
  const agents = herdr.list();
  const sessions = store.list({ activeOnly: true });

  // First pass: terminalId-exact matches; claim those agents so cwd fallback can't steal them.
  const claimed = new Set<string>();
  for (const s of sessions) {
    const byId = agents.find((a) => a.terminalId === s.herdrAgentId);
    if (byId) claimed.add(byId.terminalId);
  }

  // Second pass: full match (terminalId first, then cwd on unclaimed agents).
  for (const s of sessions) {
    const unclaimed = agents.filter(
      (a) => !claimed.has(a.terminalId) || a.terminalId === s.herdrAgentId,
    );
    const agent: HerdrAgent | null = matchAgent(s, unclaimed);
    if (!agent) store.update(s.id, { status: "done", lastState: "done" });
    else {
      if (!claimed.has(agent.terminalId)) claimed.add(agent.terminalId);
      store.update(s.id, {
        status: mapState(agent.agentStatus),
        lastState: agent.agentStatus,
        herdrAgentId: agent.terminalId, // re-point if the daemon reassigned it (no-op when same)
      });
    }
  }
}
