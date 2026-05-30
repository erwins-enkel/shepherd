import type { SessionStore } from "./store";
import { mapState, type HerdrDriver } from "./herdr";
import { classifyBlocked, type BlockReason } from "./blocked";

export class StatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReadAt = new Map<string, number>();
  private lastSig = new Map<string, string>();

  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "list" | "read">,
    private onChange: (id: string, status: string) => void,
    private onBlock: (id: string, block: BlockReason | null) => void,
    private intervalMs = 1000,
    private reclassifyMs = 3000,
    private classify: (text: string) => BlockReason = classifyBlocked,
    private now: () => number = Date.now,
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
      if (status === "blocked") this.classifyBlocked(s.id, s.herdrAgentId);
      else this.clearBlock(s.id);
    }
  }

  /** Read + classify a blocked agent at most every `reclassifyMs`; emit only on change. */
  private classifyBlocked(id: string, term: string): void {
    const t = this.now();
    if (t - (this.lastReadAt.get(id) ?? 0) < this.reclassifyMs) return;
    this.lastReadAt.set(id, t);
    let reason: BlockReason;
    try {
      reason = this.classify(this.herdr.read(term, "visible"));
    } catch {
      return; // best-effort; retry next cadence
    }
    const sig = JSON.stringify(reason);
    if (sig === this.lastSig.get(id)) return;
    this.lastSig.set(id, sig);
    this.onBlock(id, reason);
  }

  private clearBlock(id: string): void {
    if (!this.lastSig.has(id)) return;
    this.lastSig.delete(id);
    this.lastReadAt.delete(id);
    this.onBlock(id, null);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
