import type { SessionStore } from "./store";
import type { Session } from "./types";
import { mapState, type HerdrDriver, type HerdrAgent } from "./herdr";
import { classifyBlocked, tailLines, type BlockReason } from "./blocked";
import { isStalled, readSnapshot, DEFAULT_STALL, type ActivitySnapshot } from "./stall";
import { jsonlPathFor } from "./usage";

const STALL_SIG = "stall"; // fixed signature → a stall fires once per episode

export class StatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReadAt = new Map<string, number>();
  private lastSig = new Map<string, string>();
  private lastStallAt = new Map<string, number>();

  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "list" | "read">,
    private onChange: (id: string, status: string) => void,
    private onBlock: (id: string, block: BlockReason | null) => void,
    private intervalMs = 1000,
    private reclassifyMs = 3000,
    private classify: (text: string) => BlockReason = classifyBlocked,
    private now: () => number = Date.now,
    /** Latest tool-activity snapshot for a session; defaults to reading its JSONL. */
    private stallProbe: (s: Session) => ActivitySnapshot | null = (s) =>
      s.claudeSessionId ? readSnapshot(jsonlPathFor(s.worktreePath, s.claudeSessionId)) : null,
    private stallCfg = DEFAULT_STALL,
    private stallCheckMs = 30_000,
  ) {}

  tick(): void {
    const byTerm = new Map(this.herdr.list().map((a) => [a.terminalId, a]));
    const activeIds = new Set<string>();
    for (const s of this.store.list({ activeOnly: true })) {
      activeIds.add(s.id);
      const agent = byTerm.get(s.herdrAgentId);
      if (!agent) this.reapGone(s);
      else this.reconcileAgent(s, agent);
    }
    this.pruneInactive(activeIds);
  }

  /**
   * The herdr agent is gone (claude exited / user ctrl-c'd the session).
   * Mirror reconcile()'s startup behavior, but live — otherwise the session
   * stays "running" forever and the pty client keeps re-attaching a dead
   * terminal (herdr replies agent_not_found in a tight reconnect loop).
   */
  private reapGone(s: Session): void {
    this.clearBlock(s.id);
    if (s.status !== "done") {
      this.store.update(s.id, { status: "done", lastState: "done" });
      this.onChange(s.id, "done");
    }
  }

  /** Sync a live agent's status into the store and route its block/stall handling. */
  private reconcileAgent(s: Session, agent: HerdrAgent): void {
    const status = mapState(agent.agentStatus);
    if (status !== s.status || agent.agentStatus !== s.lastState) {
      this.store.update(s.id, { status, lastState: agent.agentStatus });
      this.onChange(s.id, status);
    }
    if (status === "blocked") this.maybeClassify(s.id, s.herdrAgentId);
    else if (status === "running") this.maybeStall(s);
    else this.clearBlock(s.id);
  }

  /** Prune tracking state for sessions no longer active (archived/removed). */
  private pruneInactive(activeIds: Set<string>): void {
    for (const id of this.lastSig.keys()) {
      if (!activeIds.has(id)) {
        this.lastReadAt.delete(id);
        this.lastSig.delete(id);
        this.lastStallAt.delete(id);
      }
    }
  }

  /**
   * Flag a *working* agent that has gone silent — no new tool-use within the
   * stall window (a tool still running is excluded until the hung-command
   * ceiling). Surfaces as a "needs you" reason; fires once until activity
   * resumes, then re-arms. Throttled to `stallCheckMs` per session.
   */
  private maybeStall(s: Session): void {
    const t = this.now();
    if (t - (this.lastStallAt.get(s.id) ?? 0) < this.stallCheckMs) return;
    this.lastStallAt.set(s.id, t);
    let snap: ActivitySnapshot | null;
    try {
      snap = this.stallProbe(s);
    } catch (err) {
      console.warn(`[poller] stall probe failed for ${s.id}:`, err);
      return; // best-effort; retry next cadence
    }
    if (!snap || !isStalled(snap, t, this.stallCfg)) {
      this.clearBlock(s.id); // activity resumed (or never stalled) → re-arm
      return;
    }
    if (this.lastSig.get(s.id) === STALL_SIG) return; // already announced this episode
    this.lastSig.set(s.id, STALL_SIG);
    let tail: string[] = [];
    try {
      tail = tailLines(this.herdr.read(s.herdrAgentId, "visible"));
    } catch {
      // terminal read is best-effort context; an empty tail still flags the stall
    }
    this.onBlock(s.id, { shape: "stall", options: [], tail });
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

  /**
   * Manually clear a *stall* flag without re-arming it: broadcasts the clear but
   * keeps `lastSig` so `maybeStall`'s once-per-episode guard suppresses an
   * immediate re-fire. The episode re-arms on its own when activity resumes
   * (the `!isStalled` path in `maybeStall` calls `clearBlock`), so a later
   * genuine stall still surfaces. No-op (returns false) unless a stall is live.
   */
  acknowledgeStall(id: string): boolean {
    if (this.lastSig.get(id) !== STALL_SIG) return false;
    this.onBlock(id, null);
    return true;
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
