import type { SessionStore } from "./store";
import { mapState, type HerdrDriver } from "./herdr";

export class StatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "list">,
    private onChange: (id: string, status: string) => void,
    private intervalMs = 1000,
  ) {}

  tick(): void {
    const byTerm = new Map(this.herdr.list().map((a) => [a.terminalId, a]));
    for (const s of this.store.list({ activeOnly: true })) {
      const agent = byTerm.get(s.herdrAgentId);
      if (!agent) continue;
      const status = mapState(agent.agentStatus);
      if (status !== s.status || agent.agentStatus !== s.lastState) {
        this.store.update(s.id, { status, lastState: agent.agentStatus });
        this.onChange(s.id, status);
      }
    }
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
