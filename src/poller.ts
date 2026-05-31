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
    const activeIds = new Set<string>();
    for (const s of this.store.list({ activeOnly: true })) {
      activeIds.add(s.id);
      const agent = byTerm.get(s.herdrAgentId);
      if (!agent) {
        // the herdr agent is gone (claude exited / user ctrl-c'd the session).
        // mirror reconcile()'s startup behavior, but live — otherwise the session
        // stays "running" forever and the pty client keeps re-attaching a dead
        // terminal (herdr replies agent_not_found in a tight reconnect loop).
        this.clearBlock(s.id);
        if (s.status !== "done") {
          this.store.update(s.id, { status: "done", lastState: "done" });
          this.onChange(s.id, "done");
        }
        continue;
      }
      const status = mapState(agent.agentStatus);
      if (status !== s.status || agent.agentStatus !== s.lastState) {
        this.store.update(s.id, { status, lastState: agent.agentStatus });
        this.onChange(s.id, status);
      }
      if (status === "blocked") this.maybeClassify(s.id, s.herdrAgentId);
      else this.clearBlock(s.id);
    }
    // prune tracking state for sessions no longer active (archived/removed)
    for (const id of this.lastSig.keys()) {
      if (!activeIds.has(id)) {
        this.lastReadAt.delete(id);
        this.lastSig.delete(id);
      }
    }
  }

  /** Read + classify a blocked agent at most every `reclassifyMs`; emit only on change. */
  private maybeClassify(id: string, term: string): void {
    const t = this.now();
    if (t - (this.lastReadAt.get(id) ?? 0) < this.reclassifyMs) return;
    this.lastReadAt.set(id, t);
    let reason: BlockReason;
    try {
      reason = this.classify(this.herdr.read(term, "visible"));
    } catch (err) {
      console.warn(`[poller] classify failed for ${id}:`, err);
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
