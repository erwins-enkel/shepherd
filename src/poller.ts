import type { SessionStore } from "./store";
import type { Session } from "./types";
import { mapState, matchAgents, type HerdrDriver, type HerdrAgent } from "./herdr";
import { classifyBlocked, tailLines, type BlockReason } from "./blocked";
import { isStalled, DEFAULT_STALL, type ActivitySnapshot } from "./stall";
import { jsonlPathFor } from "./usage";
import { readTranscriptSignals, STRIP_WINDOW_MS, type SessionActivity } from "./activity-signal";
import { maintenance } from "./maintenance";
import { scanListeningPortsByWorktree } from "./process-reaper";
import { pickPrimaryPort } from "./preview";
import { config } from "./config";

const STALL_SIG = "stall"; // fixed signature → a stall fires once per episode

/** Both transcript-derived signals from a single read; the unified probe's result. */
type TranscriptSignals = { snapshot: ActivitySnapshot | null; activity: SessionActivity | null };

/**
 * Injectable preview wiring: service + throttle cadence + scan/pick overrides.
 * Defaults to the real implementations; tests inject fakes to avoid /proc + network.
 */
export interface PreviewWiring {
  service: {
    ensure(sessionId: string, devPort: number): number | null;
    release(sessionId: string): void;
    converge(active: Array<{ sessionId: string; devPort: number }>): void;
    snapshot(): Record<string, { previewPort: number | null }>;
  };
  sweepMs: number;
  /** Batched /proc scan: builds the inode→port map ONCE and resolves all worktrees.
   *  Defaults to the real `scanListeningPortsByWorktree`. */
  scan: (worktrees: string[]) => Map<string, number[]>;
  /** Pick the primary dev port from a set of listening ports.
   *  Defaults to the real `pickPrimaryPort`. */
  pick: (ports: number[]) => Promise<number | null>;
}

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
  /** Interim terminal-diff state — used ONLY when the transcript probe yields
   *  nothing (Claude Code 2.1.169 stopped writing the JSONL live during a
   *  session). Kept separate from `lastVisible` (which belongs to
   *  `evaluateStall`'s gate) so the two liveness diffs never trample each other;
   *  this whole cluster goes dormant the moment the transcript starts producing
   *  signals again. See `probeTerminalInterim`. */
  private lastInterimVisible = new Map<string, string>();
  /** Per-session heartbeat ticks (ms epochs of probes where the visible buffer
   *  changed), windowed to STRIP_WINDOW_MS — drives the interim heat-strip. */
  private interimTicks = new Map<string, number[]>();
  /** Per-session last time the interim visible buffer changed; the stall baseline. */
  private lastInterimChangeAt = new Map<string, number>();
  /** Sessions whose interim terminal read is in flight — the read is dispatched
   *  fire-and-forget off the (synchronous) tick, so a slow read must not let the
   *  next cadence pile a second read on top; we skip while one is pending. */
  private interimInFlight = new Set<string>();

  /** Timestamp of the last completed preview sweep start (0 = never). */
  private lastPreviewSweepAt = 0;
  /** True while an async preview sweep is in flight (re-entrancy guard). */
  private previewSweeping = false;
  /** The resolved preview wiring (with real defaults filled in). */
  private readonly previewWiring: PreviewWiring;

  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "list" | "read" | "readAsync">,
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
    /**
     * Preview wiring: injectable for tests; defaults to real PreviewService +
     * real scan/pick + config.previewSweepMs. Omit to leave preview disabled
     * (existing poller tests that don't pass this still work).
     */
    preview?: Partial<PreviewWiring>,
  ) {
    // Merge supplied overrides with real defaults. When preview is omitted entirely
    // we create a no-op wiring so tick() never throws on undefined access.
    this.previewWiring = {
      service: preview?.service ?? {
        ensure: () => null,
        release: () => {},
        converge: () => {},
        snapshot: () => ({}),
      },
      sweepMs: preview?.sweepMs ?? config.previewSweepMs,
      scan: preview?.scan ?? ((worktrees) => scanListeningPortsByWorktree(worktrees)),
      pick: preview?.pick ?? ((ports) => pickPrimaryPort(ports)),
    };
  }

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
    // preview sweep: throttled + re-entrancy guarded; fire-and-forget (never blocks tick)
    this.maybeRunPreviewSweep(sessions);
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
      ...this.lastInterimVisible.keys(),
      ...this.interimTicks.keys(),
      ...this.lastInterimChangeAt.keys(),
      ...this.interimInFlight.keys(),
    ]);
    for (const id of tracked) {
      if (!activeIds.has(id)) {
        this.lastReadAt.delete(id);
        this.lastSig.delete(id);
        this.lastProbeAt.delete(id);
        this.lastActivitySig.delete(id);
        this.lastActivity.delete(id);
        this.lastVisible.delete(id);
        this.lastInterimVisible.delete(id);
        this.interimTicks.delete(id);
        this.lastInterimChangeAt.delete(id);
        this.interimInFlight.delete(id);
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
   * The diff applies ONLY to the pure-generation case (!pending) — a tool still
   * running past `pendingStallMs` is a hung command whose elapsed timer also
   * ticks, so it bypasses the gate and fires directly.
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

    // ── interim path: transcript yielded NOTHING (the CC 2.1.169 case) ──
    // Claude Code 2.1.169 stopped flushing the transcript JSONL live during a
    // session (it now writes only on exit), so for every running agent the probe
    // comes back empty → the heartbeat strip would render all-empty AND stall
    // detection would be disabled (`evaluateStall` bails on a null snapshot
    // BEFORE it ever reads the terminal). When BOTH signals are null we instead
    // derive a coarse-but-live heartbeat + stall from the herdr "visible" buffer.
    // This is NOT free: it adds ONE fresh `visible` read per running agent per
    // probe cadence (the transcript path early-returned at zero reads in this
    // 2.1.169 world). To keep that fan-out off Bun's single loop, the read is
    // ASYNC (`readAsync`) and dispatched fire-and-forget — `tick()` never blocks
    // on it. No Claude-Code-side hooks, works on already-running agents. This
    // branch is mutually exclusive with the transcript path below: the instant
    // Claude Code restores live transcript writes (signals become non-null) it
    // goes dormant automatically and the original path runs.
    if (signals.activity == null && signals.snapshot == null) {
      void this.probeTerminalInterim(s, t);
      return;
    }

    // ── activity emit (deduped by signal content) ──
    if (signals.activity) {
      this.emitActivity(s.id, signals.activity);
    }

    // ── stall decision: transcript candidate + live-terminal liveness gate ──
    this.evaluateStall(s, t, signals.snapshot);
  }

  /**
   * Interim heartbeat + stall, derived from the live terminal alone, for when the
   * transcript probe yields nothing (Claude Code 2.1.169 no longer writes the
   * JSONL live). Reads the visible buffer EXACTLY ONCE — and ASYNCHRONOUSLY, via
   * `readAsync`, so the read never blocks Bun's single loop (it fans out across
   * every running agent each probe cadence). Dispatched fire-and-forget from the
   * synchronous `maybeProbe`; an `interimInFlight` guard skips a fresh dispatch
   * while a prior read for the same session is still pending, so a slow read can't
   * pile up. Drives BOTH signals off that single read:
   *
   *  1. Heartbeat — a running agent mid-turn keeps its spinner/elapsed/token
   *     counter ticking, so its visible buffer changes between ~7s probes. Each
   *     change pushes a tick (windowed to STRIP_WINDOW_MS); the client ages the
   *     strip live off its own clock, so an unchanged probe simply re-emits
   *     nothing (the dedupe below) rather than re-pushing.
   *  2. Stall — track the last time the buffer changed. Changed → clear any
   *     stall and reset the baseline. Unchanged for >= stallMs (with a one-cycle
   *     baseline deferral on the first sample) → fire (idempotent per episode).
   *
   * KNOWN LIMITATION: this interim stall is frozen-TUI-only. It does NOT detect a
   * hung command whose elapsed timer keeps ticking (the buffer still changes, so
   * it reads as "alive") — that needs the durable hook mechanism (a separate held
   * task). It also can't carry a tool-use summary, so the heartbeat summary is
   * null. Best-effort throughout: a throwing terminal read is swallowed and
   * retried next cadence, never propagated out of the tick.
   */
  private async probeTerminalInterim(s: Session, t: number): Promise<void> {
    const id = s.id;
    if (this.interimInFlight.has(id)) return; // a prior read is still pending → skip
    this.interimInFlight.add(id);
    try {
      let visible: string;
      try {
        visible = await this.herdr.readAsync(s.herdrAgentId, "visible");
      } catch {
        return; // can't assess this cycle → best-effort, retry next cadence
      }
      // A running agent must not carry a stale *non-stall* block sig left over from a
      // prior blocked state (the old transcript path cleared this via
      // evaluateStall→clearBlock). Drop it here so a blocked→running resume still
      // emits its clear; leave a live stall sig alone (its own clearStall/fireStall
      // logic below owns the once-per-episode guard).
      if (this.lastSig.has(id) && this.lastSig.get(id) !== STALL_SIG) this.clearBlock(id);
      const prev = this.lastInterimVisible.get(id);
      const changed = prev !== undefined && visible !== prev;

      // 1. heartbeat: a changed buffer is one live "tick"; window the list.
      if (changed) {
        const ticks = this.interimTicks.get(id) ?? [];
        ticks.push(t);
        const cutoff = t - STRIP_WINDOW_MS;
        const windowed = ticks.filter((ts) => ts >= cutoff);
        this.interimTicks.set(id, windowed);
        // summary is null — the terminal diff can't name the tool-use; recentErrTs
        // is always empty for the same reason. lastActivityTs = newest tick (`t`
        // was just pushed and survives the window, so `windowed` is never empty).
        this.emitActivity(id, {
          lastActivityTs: windowed[windowed.length - 1]!,
          summary: null,
          recentTs: windowed,
          recentErrTs: [],
        });
      }

      // 2. stall: a moving terminal is alive; a frozen one past stallMs is stalled.
      if (changed) {
        this.lastInterimChangeAt.set(id, t);
        this.clearStall(id);
      } else if (!this.lastInterimChangeAt.has(id)) {
        // first sample (no baseline yet) → defer one cycle, never fire blind.
        this.lastInterimChangeAt.set(id, t);
      } else if (t - this.lastInterimChangeAt.get(id)! >= this.stallCfg.stallMs) {
        this.fireStall(id, visible); // idempotent per episode
      }

      this.lastInterimVisible.set(id, visible);
    } finally {
      this.interimInFlight.delete(id);
    }
  }

  /** Emit an activity signal, deduped by content so clients see only real changes. */
  private emitActivity(id: string, activity: SessionActivity): void {
    const sig = JSON.stringify(activity);
    if (sig === this.lastActivitySig.get(id)) return;
    this.lastActivitySig.set(id, sig);
    this.lastActivity.set(id, activity);
    this.onActivity(id, activity);
  }

  /**
   * Confirm or clear a stall for a running agent from its transcript snapshot.
   * No candidate (transcript progressing) → clear any stall + reset baseline.
   * A candidate reads the live terminal once (for the tail and the liveness diff).
   * The diff applies ONLY to pure-generation candidates (`!pending`): a hung
   * command (pending past the ceiling) keeps its "esc to interrupt" timer ticking,
   * so it bypasses the gate and fires directly.
   */
  private evaluateStall(s: Session, t: number, snap: ActivitySnapshot | null): void {
    if (!snap || !isStalled(snap, t, this.stallCfg)) {
      this.clearBlock(s.id); // transcript progressed → clear any stall + reset baseline
      return;
    }
    let visible: string;
    try {
      visible = this.herdr.read(s.herdrAgentId, "visible");
    } catch {
      return; // can't assess this cycle → best-effort, retry next cadence
    }
    // Pure-generation candidate: a terminal still ticking (or no baseline yet) is
    // not a stall this cycle — clear one that recovered and wait. Pending (hung
    // command) skips the gate and fires directly.
    // NOTE: this is deliberately a "TUI alive" check, not "model progressing" —
    // the buffer includes the client-side elapsed-seconds timer, so any rendering
    // TUI reads as alive. That's the intended conservative tradeoff: it only fires
    // when the TUI is fully frozen, which is exactly the false positive being fixed
    // (a long generation turn whose TUI keeps rendering must NOT flag).
    if (!snap.pending && this.sampleTerminal(s.id, visible) !== "frozen") {
      this.clearStall(s.id);
      return;
    }
    this.fireStall(s.id, visible);
  }

  /**
   * Record the current visible buffer as the new liveness baseline and report how
   * it compares to the previous sample. A turn still generating keeps its
   * spinner/elapsed/token counter ticking, so the buffer moves between probes; a
   * wedged/idle turn leaves it frozen. "fresh" on the first probe of an episode —
   * nothing to compare against yet, so the caller defers one cycle.
   */
  private sampleTerminal(id: string, visible: string): "fresh" | "moving" | "frozen" {
    const prev = this.lastVisible.get(id);
    this.lastVisible.set(id, visible);
    if (prev === undefined) return "fresh";
    return visible === prev ? "frozen" : "moving";
  }

  /** Clear a live stall flag (no-op if none); leaves the terminal baseline intact. */
  private clearStall(id: string): void {
    if (this.lastSig.get(id) !== STALL_SIG) return;
    this.lastSig.delete(id);
    this.lastReadAt.delete(id);
    this.onBlock(id, null);
  }

  /** Emit a stall block once per episode (guarded by `lastSig === STALL_SIG`). */
  private fireStall(id: string, visible: string): void {
    if (this.lastSig.get(id) === STALL_SIG) return; // already announced this episode
    this.lastSig.set(id, STALL_SIG);
    this.onBlock(id, { shape: "stall", options: [], tail: tailLines(visible) });
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

  /**
   * Throttle + re-entrancy gate for the async preview sweep.
   * Called from tick() after the session loop with the already-fetched sessions list
   * (no second store.list()). Fire-and-forget — never awaited, never throws to the caller.
   */
  private maybeRunPreviewSweep(sessions: Session[]): void {
    const t = this.now();
    if (t - this.lastPreviewSweepAt < this.previewWiring.sweepMs) return;
    if (this.previewSweeping) return;

    // Isolated sessions with a worktreePath are the candidates.
    const isolated = sessions.filter((s) => s.isolated && s.worktreePath);

    if (isolated.length === 0) {
      // No candidates: converge([]) cheap-tears-down any stale listeners.
      // No /proc scan needed.
      this.lastPreviewSweepAt = t;
      this.previewWiring.service.converge([]);
      return;
    }

    this.lastPreviewSweepAt = t;
    this.previewSweeping = true;
    void this.runPreviewSweep(isolated)
      .catch((err) => {
        console.warn("[poller] preview sweep failed:", err);
      })
      .finally(() => {
        this.previewSweeping = false;
      });
  }

  /**
   * Async core of the preview sweep. Builds the /proc map ONCE, picks a primary
   * port per session, then calls converge() on the full active set. The PreviewService
   * handles bind/teardown transitions and fires onChange on real changes — the poller
   * does NOT dedupe or emit directly.
   */
  private async runPreviewSweep(isolated: Session[]): Promise<void> {
    const worktrees = isolated.map((s) => s.worktreePath);
    // Single /proc scan for ALL sessions — never once per session.
    const portsMap = this.previewWiring.scan(worktrees);

    const active: Array<{ sessionId: string; devPort: number }> = [];
    for (const s of isolated) {
      const ports = portsMap.get(s.worktreePath) ?? [];
      const devPort = await this.previewWiring.pick(ports);
      if (devPort !== null) active.push({ sessionId: s.id, devPort });
    }

    // converge releases sessions absent from `active` and ensures those present.
    // onChange (wired in index.ts) emits session:preview on real transitions only.
    this.previewWiring.service.converge(active);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
