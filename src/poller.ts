import type { SessionStore } from "./store";
import type { Session } from "./types";
import { mapState, type HerdrDriver, type HerdrAgent } from "./herdr";
import { classifyBlocked, tailLines, type BlockReason } from "./blocked";
import { isStalled, DEFAULT_STALL, type ActivitySnapshot } from "./stall";
import { jsonlPathFor } from "./usage";
import { readTranscriptSignals, type SessionActivity } from "./activity-signal";

const STALL_SIG = "stall"; // fixed signature → a stall fires once per episode

/** Both transcript-derived signals from a single read; the unified probe's result. */
type TranscriptSignals = { snapshot: ActivitySnapshot | null; activity: SessionActivity | null };

export class StatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReadAt = new Map<string, number>();
  private lastSig = new Map<string, string>();
  private lastProbeAt = new Map<string, number>();
  private lastActivitySig = new Map<string, string>();
  private lastActivity = new Map<string, SessionActivity>();

  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "list" | "read">,
    private onChange: (id: string, status: string) => void,
    private onBlock: (id: string, block: BlockReason | null) => void,
    private intervalMs = 1000,
    private reclassifyMs = 3000,
    private classify: (text: string) => BlockReason = classifyBlocked,
    private now: () => number = Date.now,
    /**
     * Both transcript-derived signals (stall snapshot + activity) for a running
     * session, from a SINGLE read+parse of its JSONL. Defaults to reading the file;
     * injectable in tests. One read feeds both the stall decision and the activity
     * emit, so the transcript is no longer parsed twice per running agent per tick.
     */
    private probe: (s: Session) => TranscriptSignals = (s) =>
      s.claudeSessionId
        ? readTranscriptSignals(jsonlPathFor(s.worktreePath, s.claudeSessionId))
        : { snapshot: null, activity: null },
    private stallCfg = DEFAULT_STALL,
    private probeCheckMs = 7000,
    /** Pushed when a session's manual readyToMerge flag is auto-cleared on resume. */
    private onReady: (id: string, ready: boolean) => void = () => {},
    /** Pushed when a running session's heartbeat or current activity changes. */
    private onActivity: (id: string, activity: SessionActivity) => void = () => {},
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
    // There's a next action again → drop the manual "ready to merge" parking so
    // the row rejoins the active group. Sticky otherwise (idle/done keep it).
    if ((status === "running" || status === "blocked") && s.readyToMerge) {
      this.store.update(s.id, { readyToMerge: false });
      this.onReady(s.id, false);
    }
    if (status === "blocked") this.maybeClassify(s.id, s.herdrAgentId);
    else if (status === "running") this.maybeProbe(s);
    else this.clearBlock(s.id);
  }

  /** Prune tracking state for sessions no longer active (archived/removed). */
  private pruneInactive(activeIds: Set<string>): void {
    const tracked = new Set([
      ...this.lastSig.keys(),
      ...this.lastReadAt.keys(),
      ...this.lastProbeAt.keys(),
      ...this.lastActivitySig.keys(),
      ...this.lastActivity.keys(),
    ]);
    for (const id of tracked) {
      if (!activeIds.has(id)) {
        this.lastReadAt.delete(id);
        this.lastSig.delete(id);
        this.lastProbeAt.delete(id);
        this.lastActivitySig.delete(id);
        this.lastActivity.delete(id);
      }
    }
  }

  /** Last-emitted activity signal per running session, for client bootstrap. */
  activitySnapshot(): Record<string, SessionActivity> {
    return Object.fromEntries(this.lastActivity);
  }

  /**
   * Unified per-tick probe for a *running* agent: a SINGLE read+parse of its
   * transcript feeds BOTH the activity signal and the stall decision, replacing
   * the two redundant whole-file reads we used to do per poll. Throttled to
   * `probeCheckMs` per session via one `lastProbeAt` map; best-effort (a throwing
   * probe is logged and skipped until the next cadence).
   *
   * Activity: emit the heartbeat/summary signal, deduped by content so clients
   * only receive genuine changes; a null signal (no transcript yet) is skipped.
   *
   * Stall: flag a working agent gone silent — no new tool-use within the stall
   * window (a tool still running is excluded until the hung-command ceiling).
   * Surfaces as a "needs you" reason; fires once per episode (guarded by
   * `lastSig === STALL_SIG`) until activity resumes, then re-arms.
   *
   * Note: stall detection now runs at the (faster) `probeCheckMs` cadence rather
   * than the old 30s stall cadence. This only improves detection latency — the
   * once-per-episode `lastSig` guard means no extra block emissions, and the
   * stall *windows* (`stallMs`/`pendingStallMs`) are unchanged.
   */
  private maybeProbe(s: Session): void {
    const t = this.now();
    if (t - (this.lastProbeAt.get(s.id) ?? 0) < this.probeCheckMs) return;
    this.lastProbeAt.set(s.id, t);
    let signals: TranscriptSignals;
    try {
      signals = this.probe(s);
    } catch (err) {
      console.warn(`[poller] transcript probe failed for ${s.id}:`, err);
      return; // best-effort; retry next cadence
    }

    // ── activity emit (deduped by signal content) ──
    if (signals.activity) {
      const sig = JSON.stringify(signals.activity);
      if (sig !== this.lastActivitySig.get(s.id)) {
        this.lastActivitySig.set(s.id, sig);
        this.lastActivity.set(s.id, signals.activity);
        this.onActivity(s.id, signals.activity);
      }
    }

    // ── stall decision (identical to the former maybeStall) ──
    const snap = signals.snapshot;
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
   * keeps `lastSig` so `maybeProbe`'s once-per-episode guard suppresses an
   * immediate re-fire. The episode re-arms on its own when activity resumes
   * (the `!isStalled` path in `maybeProbe` calls `clearBlock`), so a later
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
