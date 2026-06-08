import type { SessionStore } from "./store";
import type { Session } from "./types";
import { mapState, matchAgents, type HerdrDriver, type HerdrAgent } from "./herdr";
import { classifyBlocked, tailLines, type BlockReason } from "./blocked";
import { isStalled, DEFAULT_STALL, type ActivitySnapshot } from "./stall";
import { jsonlPathFor } from "./usage";
import { readTranscriptSignals, type SessionActivity } from "./activity-signal";
import { maintenance } from "./maintenance";

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
  /** Last visible-terminal buffer per stall-candidate session, for the liveness
   *  diff. A transcript gone silent past the stall window only makes a turn a
   *  *candidate*; comparing the live terminal across probes confirms it. A turn
   *  still generating keeps its spinner/elapsed/token counter ticking, so the
   *  buffer changes between probes; a wedged or idle turn leaves it frozen. */
  private lastVisible = new Map<string, string>();

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
    // herdr is mid-update: don't poll — a list() here would resurrect the herdr
    // server and (seeing no agents) wrongly reap every live session.
    if (maintenance.active) return;
    // `herdr list` now carries a hard timeout (HERDR_TIMEOUT_MS), so an
    // unresponsive herdr THROWS rather than blocking. This runs on a 1s interval
    // with no surrounding try/catch, so an unhandled throw would crash shepherd
    // (→ a restart-502, the very thing this design removes). Skip the tick on any
    // herdr failure and retry next cadence — same best-effort stance as the
    // read-based maybeStall/maybeClassify paths below. Probe herdr before the
    // store so a failure bails without touching session state.
    let agents: HerdrAgent[];
    try {
      agents = this.herdr.list();
    } catch (err) {
      console.warn("[poller] herdr list failed; skipping tick:", err);
      return;
    }
    const sessions = this.store.list({ activeOnly: true });
    const matched = matchAgents(sessions, agents);
    const activeIds = new Set<string>();
    for (const s of sessions) {
      activeIds.add(s.id);
      const agent = matched.get(s.id) ?? null;
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
    const idChanged = agent.terminalId !== s.herdrAgentId;
    if (idChanged || status !== s.status || agent.agentStatus !== s.lastState) {
      this.store.update(s.id, {
        status,
        lastState: agent.agentStatus,
        ...(idChanged ? { herdrAgentId: agent.terminalId } : {}),
      });
      this.onChange(s.id, status); // nudge clients to re-attach the PTY to the fresh terminal
    }
    if (idChanged) s = { ...s, herdrAgentId: agent.terminalId };
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
      ...this.lastVisible.keys(),
    ]);
    for (const id of tracked) {
      if (!activeIds.has(id)) {
        this.lastReadAt.delete(id);
        this.lastSig.delete(id);
        this.lastProbeAt.delete(id);
        this.lastActivitySig.delete(id);
        this.lastActivity.delete(id);
        this.lastVisible.delete(id);
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
   * Stall: a working agent whose transcript has gone silent past the stall
   * window (no new tool-use; a running tool is excluded until the hung-command
   * ceiling) is only a *candidate*. A long pure-generation turn (writing a plan,
   * deep thinking) emits no tool-use and flushes nothing to the transcript until
   * it completes, so it looks identical to a wedged turn on the transcript alone.
   * We confirm with a live-terminal liveness diff: a turn still generating keeps
   * its spinner/elapsed/token counter ticking, so the visible buffer changes
   * between probes; only a frozen buffer + a silent transcript is a real stall.
   * Surfaces as a "needs you" reason; fires once per episode (guarded by
   * `lastSig === STALL_SIG`) until the turn progresses, then re-arms.
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

    // ── stall decision: transcript candidate + live-terminal liveness gate ──
    const snap = signals.snapshot;
    if (!snap || !isStalled(snap, t, this.stallCfg)) {
      this.clearBlock(s.id); // transcript progressed → clear any stall + reset baseline
      return;
    }
    // Transcript silent past the window → stall *candidate*. Confirm against the
    // live terminal: a turn still generating keeps ticking, so its visible buffer
    // changes between probes; a wedged/idle turn leaves it frozen.
    let visible: string;
    try {
      visible = this.herdr.read(s.herdrAgentId, "visible");
    } catch {
      return; // can't assess liveness this cycle → best-effort, retry next cadence
    }
    const prev = this.lastVisible.get(s.id);
    this.lastVisible.set(s.id, visible);
    if (prev === undefined) return; // no baseline yet → defer one probe to compare
    if (visible !== prev) {
      // terminal still moving → the turn is alive, not stalled. Clear a stall that
      // recovered; keep the fresh baseline (already set) for the next comparison.
      if (this.lastSig.get(s.id) === STALL_SIG) {
        this.lastSig.delete(s.id);
        this.lastReadAt.delete(s.id);
        this.onBlock(s.id, null);
      }
      return;
    }
    // transcript silent AND terminal frozen → genuine stall.
    if (this.lastSig.get(s.id) === STALL_SIG) return; // already announced this episode
    this.lastSig.set(s.id, STALL_SIG);
    this.onBlock(s.id, { shape: "stall", options: [], tail: tailLines(visible) });
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
    this.lastVisible.delete(id); // reset the stall liveness baseline regardless of block state
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
