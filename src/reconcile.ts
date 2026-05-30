import type { SessionStore } from "./store";
import { mapState, type HerdrDriver } from "./herdr";

export function reconcile(store: SessionStore, herdr: Pick<HerdrDriver, "list">): void {
  const byTerm = new Map(herdr.list().map((a) => [a.terminalId, a]));
  for (const s of store.list({ activeOnly: true })) {
    const agent = byTerm.get(s.herdrAgentId);
    if (!agent) store.update(s.id, { status: "done", lastState: "done" });
    else store.update(s.id, { status: mapState(agent.agentStatus), lastState: agent.agentStatus });
  }
}
