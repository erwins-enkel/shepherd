import type { SessionStore } from "./store";
import type { Session } from "./types";
import { mapState, matchAgents, type HerdrDriver, type HerdrAgent } from "./herdr";
import { classifyBlocked, hasActiveSpinner, tailLines, type BlockReason } from "./blocked";
import { isStalled, DEFAULT_STALL, type ActivitySnapshot } from "./stall";
import { jsonlPathFor } from "./usage";
import { readTranscriptSignals, STRIP_WINDOW_MS, type SessionActivity } from "./activity-signal";
import { maintenance } from "./maintenance";
import { scanListeningPortsByWorktree, scanClaudeAliveByWorktree } from "./process-reaper";
import { resolveDevPort } from "./preview";
import { config } from "./config";

const STALL_SIG = "stall"; // fixed signature → a stall fires once per episode

/**
 * Notification `notification_type`s that assert an awaiting-input edge (Phase 1,
 * issue #704). Deliberately a small, named constant because under
 * `--dangerously-skip-permissions` (how Shepherd spawns every agent) tool-permission
 * prompts are suppressed, so it was unclear whether the real pausing cases emit a
 * usable edge. CONFIRMED by the Phase-0 live spike (2026-06-15): BOTH interactive-pause
 * cases — an `AskUserQuestion` pause AND an `ExitPlanMode`/plan-approval prompt — fire
 * `Notification(permission_prompt)` even under skip-permissions, so this single type
 * covers them. If some future pausing case emitted a different type, the block trigger
 * would simply stay dormant for it and detection would cleanly degrade to the
 * existing `herdr-blocked → classifyBlocked` fallback — the intended no-regression
 * path. `idle_prompt` is deliberately NOT here (idle is handled
 * by herdr mapping).
 */
const BLOCK_NOTIFICATION_TYPES = new Set(["permission_prompt"]);

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
    /** Ms since last proxy activity for a bound session, null if unbound.
     *  Optional so existing fake `service` literals in tests still compile. */
    idleSince?(sessionId: string, now: number): number | null;
  };
  sweepMs: number;
  /** Batched /proc scan: builds the inode→port map ONCE and resolves all worktrees.
   *  Defaults to the real `scanListeningPortsByWorktree`. */
  scan: (worktrees: string[]) => Map<string, number[]>;
  /** Pick the primary dev port from a set of listening ports for a given worktree.
   *  Defaults to `resolveDevPort`, which honors the agent-declared `.shepherd-preview`
   *  hint (if listening + HTTP-live) and otherwise falls back to the primary-port heuristic. */
  pick: (ports: number[], worktreePath: string) => Promise<number | null>;
  /** Opt-in idle-stop. idleMs > 0 enables it; `stop` signals a session's dev-server
   *  process (wired to SessionService.stopPreview in index.ts). Absent = disabled. */
  idleStop?: { idleMs: number; stop: (sessionId: string, signal: NodeJS.Signals) => void };
}

/**
 * Injectable claude-liveness wiring: emits when a session's worktree gains/loses
 * a live `claude` process. Defaults to the real /proc scan; tests inject fakes.
 */
export interface LivenessWiring {
  /** Single /proc pass answering "does a claude process live in this worktree?". */
  scan: (worktrees: string[]) => Map<string, boolean>;
  sweepMs: number;
  onChange: (id: string, alive: boolean) => void;
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
  /** Interim terminal-diff state — used whenever the transcript is NOT being
   *  written live (an empty JSONL, or a resumed session inheriting a frozen old
   *  one; see the liveness gate in `maybeProbe`). Kept separate from `lastVisible`
   *  (which belongs to `evaluateStall`'s gate) so the two liveness diffs never
   *  trample each other; this whole cluster is reset (`resetInterim`) the moment
   *  the transcript starts live-writing again. See `probeTerminalInterim`. */
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
  /** Per-session newest transcript-record ts seen on the PREVIOUS probe — the
   *  liveness baseline that decides transcript-vs-interim each probe. A probe whose
   *  newest record advanced past this is "live-writing" (use the transcript); one
   *  that didn't (empty, or a resumed session inheriting a frozen old JSONL) falls
   *  to the interim terminal-diff. First sighting (no baseline) counts as live so a
   *  resumed agent auto-reactivates the transcript path before settling. */
  private lastTranscriptTs = new Map<string, number>();

  /** Timestamp of the last completed preview sweep start (0 = never). */
  private lastPreviewSweepAt = 0;
  /** True while an async preview sweep is in flight (re-entrancy guard). */
  private previewSweeping = false;
  /** Per-session idle-stop escalation state: which devPort we've signalled and how
   *  far we've escalated. Reset when the server dies, the session is viewed again,
   *  or the agent resumes. */
  private previewStopState = new Map<
    string,
    { devPort: number; level: "term" | "kill"; gaveUp: boolean }
  >();
  /** The resolved preview wiring (with real defaults filled in). */
  private readonly previewWiring: PreviewWiring;

  /** Sessions herdr reports "blocked" whose TUI shows a live turn spinner —
   *  the working-while-blocked suppression episode (herdr latches blocked after
   *  an answered dialog). Membership drives the `onWorkingBlocked` display flag:
   *  added (emit true) once per episode in `maybeClassify`'s suppression branch;
   *  removed with an emit (false) on re-arm — a spinner-free tail OR the
   *  freshness gate tripping on a frozen buffer (see `lastSuppressVisible`) —
   *  on leaving herdr-blocked (`reconcileAgent`), and on reap; dropped SILENTLY
   *  on prune (the session was archived — no client cares about its flag
   *  anymore). */
  private workingWhileBlocked = new Set<string>();
  /** Per-session previous classify-read visible buffer while in a spinner-
   *  suppression episode — the freshness gate. A spinner LINE match alone is
   *  necessary but not sufficient to keep suppressing: a live spinner ticks its
   *  elapsed/token counters, so the buffer always advances across the
   *  reclassify cadence, while a wedged turn or a static buffer quoting a
   *  spinner-like line (`* Done… (3s)` as a markdown bullet) stays frozen —
   *  those must re-arm the block, not be suppressed forever. Deliberately
   *  separate from `lastVisible` (evaluateStall's gate) and
   *  `lastInterimVisible` (interim path) so the liveness diffs never trample
   *  each other. Retained across a frozen re-arm (it IS the episode memory
   *  that stops the same static buffer from re-earning first-sighting grace);
   *  dropped when the suppression context ends (non-spinner classify, leaving
   *  herdr-blocked, `clearBlock`, reap, prune). */
  private lastSuppressVisible = new Map<string, string>();

  /** Phase-1 push-hook state (issue #704), all gated by `config.hooksSignals`.
   *  Fed via HookIngest.onSignal → ingestActivity / ingestNotification; the poller
   *  stays the single owner of per-session signal dedup + the working-while-blocked
   *  state machine, so push events funnel through `emitActivity`/`maybeClassify`
   *  rather than emitting directly (which would bypass dedup + oscillate with poll).
   *  Every map is pruned in `pruneInactive` and inert when the flag is off. */
  /** Per-session ms of the last PostToolUse(/Failure) push activity — the freshness
   *  baseline that lets `maybeProbe` suppress its now-redundant transcript activity
   *  emit while the (fresher, real-summary) push path is carrying the session. */
  private lastHookActivityAt = new Map<string, number>();
  /** Per-session windowed heat-strip ticks accrued from push activity (mirrors
   *  `interimTicks`, windowed to STRIP_WINDOW_MS). */
  private hookTicks = new Map<string, number[]>();
  /** Sessions for which a Notification reported an awaiting-input edge; consumed by
   *  `reconcileAgent` to trigger a classify THIS tick (≤ ~1 tick), independent of
   *  herdr's latchy `blocked` status. */
  private hookAwaitingInput = new Set<string>();

  /** Timestamp of the last claude-liveness sweep (0 = never). */
  private lastLivenessSweepAt = 0;
  /** Last-swept per-session claude liveness; onChange fires on flips only. */
  private lastClaudeAlive = new Map<string, boolean>();
  /** The resolved liveness wiring (with real defaults filled in). */
  private readonly livenessWiring: LivenessWiring;

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
    /**
     * Claude-liveness wiring: injectable for tests; defaults to the real /proc scan
     * with a no-op onChange. Drives `session:claude-alive` so the UI only offers
     * Resume when the claude process is actually gone (husk shell).
     */
    liveness?: Partial<LivenessWiring>,
    /**
     * Pushed when a session enters/leaves the working-while-blocked display state
     * (herdr latched "blocked" but the TUI shows a live turn spinner). `true` fires
     * once per suppression episode, `false` when the episode ends — same tick as
     * (and before) any re-armed block emission.
     */
    private onWorkingBlocked: (id: string, working: boolean) => void = () => {},
    /**
     * Phase-1 (issue #704): prune the HookIngest ring buffers for sessions no longer
     * active, called from `pruneInactive` so dead sessions' buffers don't grow
     * unbounded by session count (Task-2 reviewer flag). Undefined ⇒ no-op (the
     * ingest module isn't wired, e.g. in tests / flag off).
     */
    private pruneHooks?: (activeIds: Set<string>) => void,
  ) {
    // Merge supplied overrides with real defaults. When preview is omitted entirely
    // we create a no-op wiring so tick() never throws on undefined access.
    this.previewWiring = {
      service: preview?.service ?? {
        ensure: () => null,
        release: () => {},
        converge: () => {},
        snapshot: () => ({}),
        idleSince: () => null,
      },
      sweepMs: preview?.sweepMs ?? config.previewSweepMs,
      scan: preview?.scan ?? ((worktrees) => scanListeningPortsByWorktree(worktrees)),
      pick: preview?.pick ?? ((ports, worktreePath) => resolveDevPort(ports, worktreePath)),
      idleStop: preview?.idleStop,
    };
    this.livenessWiring = {
      scan: liveness?.scan ?? ((worktrees) => scanClaudeAliveByWorktree(worktrees)),
      sweepMs: liveness?.sweepMs ?? config.previewSweepMs,
      onChange: liveness?.onChange ?? (() => {}),
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
    // claude-liveness sweep: throttled; synchronous (one cheap /proc pass)
    this.maybeRunLivenessSweep(sessions);
  }

  /**
   * Throttled sweep: does each session's worktree still host a live `claude`
   * process? Detects the husk case herdr's agent_status can't (claude exited to a
   * bare shell keeps the agent listed as idle). Emits onChange on flips only;
   * tracking for sessions no longer active is pruned in place.
   */
  private maybeRunLivenessSweep(sessions: Session[]): void {
    const t = this.now();
    if (t - this.lastLivenessSweepAt < this.livenessWiring.sweepMs) return;
    this.lastLivenessSweepAt = t;
    const candidates = sessions.filter((s) => s.worktreePath);
    let byWorktree: Map<string, boolean>;
    try {
      byWorktree = this.livenessWiring.scan(candidates.map((s) => s.worktreePath));
    } catch (err) {
      // tick() runs on a bare setInterval — a throw here would crash shepherd.
      // Skip the sweep and retry next cadence, same stance as the preview sweep.
      console.warn("[poller] claude-liveness sweep failed:", err);
      return;
    }
    const activeIds = new Set<string>();
    for (const s of candidates) {
      activeIds.add(s.id);
      const alive = byWorktree.get(s.worktreePath) ?? false;
      if (this.lastClaudeAlive.get(s.id) !== alive) {
        this.lastClaudeAlive.set(s.id, alive);
        this.livenessWiring.onChange(s.id, alive);
      }
    }
    for (const id of [...this.lastClaudeAlive.keys()]) {
      if (!activeIds.has(id)) this.lastClaudeAlive.delete(id);
    }
  }

  /** Last-swept claude-process liveness per session, for client bootstrap. */
  claudeAliveSnapshot(): Record<string, boolean> {
    return Object.fromEntries(this.lastClaudeAlive);
  }

  /** Sessions currently in the working-while-blocked display state, for client bootstrap. */
  workingBlockedSnapshot(): Record<string, boolean> {
    return Object.fromEntries([...this.workingWhileBlocked].map((id) => [id, true]));
  }

  /**
   * The herdr agent is gone (claude exited / user ctrl-c'd the session).
   * Mirror reconcile()'s startup behavior, but live — otherwise the session
   * stays "running" forever and the pty client keeps re-attaching a dead
   * terminal (herdr replies agent_not_found in a tight reconnect loop).
   */
  private reapGone(s: Session): void {
    if (this.workingWhileBlocked.delete(s.id)) this.onWorkingBlocked(s.id, false);
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
    this.dropReadyToMergeIfActionable(s, status);
    // Left herdr-blocked (running/idle/done alike) → the working-while-blocked
    // display flag must drop in the SAME tick, not via the throttled probe paths.
    // The suppression-episode baseline goes with it (flag or not — a frozen
    // episode that already re-armed still holds one).
    if (status !== "blocked") {
      this.lastSuppressVisible.delete(s.id);
      if (this.workingWhileBlocked.delete(s.id)) this.onWorkingBlocked(s.id, false);
    }
    // Phase-1 push block-trigger (issue #704): a Notification awaiting-input edge
    // can classify THIS tick even before herdr latches "blocked". When it handles the
    // session (announced a block), short-circuit so the normal routing below doesn't
    // immediately wipe the just-emitted block. See tryHookAwaitingBlock.
    if (status !== "blocked" && this.tryHookAwaitingBlock(s)) return;

    if (status === "blocked") this.maybeClassify(s.id, s.herdrAgentId);
    else if (status === "running") this.maybeProbe(s);
    else this.clearBlock(s.id);
  }

  /**
   * There's a next action again → drop the manual "ready to merge" parking so the row
   * rejoins the active group. Sticky otherwise (idle/done keep it).
   */
  private dropReadyToMergeIfActionable(s: Session, status: Session["status"]): void {
    if ((status === "running" || status === "blocked") && s.readyToMerge) {
      this.store.update(s.id, { readyToMerge: false });
      this.onReady(s.id, false);
    }
  }

  /**
   * Phase-1 push block-trigger (issue #704): a Notification reported an awaiting-input
   * edge. Classify THIS tick even if herdr hasn't latched "blocked" yet, so the block
   * surfaces ≤ ~1 tick after the agent asks — independent of herdr's latchy status +
   * the PTY-regex *detection* heuristics. classifyBlocked still supplies the menu/yes-no
   * options + tail (the Notification payload has none). The PTY read stays on the TICK
   * (maybeClassify), never in the route (single-loop-no-sync-exec). Callers skip this
   * when status==="blocked" already (the normal branch classifies), to avoid a double
   * read. The marker is consumed only once a classify ACTUALLY runs (maybeClassify
   * returns true): if its reclassifyMs throttle skips this tick, we KEEP the marker and
   * retry next tick — still faster/more reliable than waiting on herdr's latchy
   * "blocked" fallback. When the type never arrives (the common skip-permissions case),
   * this is dormant and detection stays on the herdr-blocked fallback — no regression.
   *
   * Returns true when it announced an awaiting-input/menu/yes-no block (lastSig set to a
   * non-stall reason) → the caller must short-circuit: running the normal running/idle
   * routing this tick (`maybeProbe`→`evaluateStall`→`clearBlock`, or the idle-branch
   * `clearBlock`) would immediately wipe the just-emitted block. The next tick (no
   * marker) routes normally, so a resolved prompt clears via the usual path. A non-block
   * classify (e.g. a working spinner suppressed it) returns false → normal routing runs.
   */
  private tryHookAwaitingBlock(s: Session): boolean {
    if (!config.hooksSignals || !this.hookAwaitingInput.has(s.id)) return false;
    // Consume the marker only when the classify actually ran (throttle didn't skip);
    // a throttled tick keeps the marker so the next tick retries the surface.
    if (this.maybeClassify(s.id, s.herdrAgentId)) this.hookAwaitingInput.delete(s.id);
    const sig = this.lastSig.get(s.id);
    return sig !== undefined && sig !== STALL_SIG;
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
      ...this.lastTranscriptTs.keys(),
      ...this.previewStopState.keys(),
      ...this.workingWhileBlocked,
      ...this.lastSuppressVisible.keys(),
      ...this.lastHookActivityAt.keys(),
      ...this.hookTicks.keys(),
      ...this.hookAwaitingInput,
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
        this.lastTranscriptTs.delete(id);
        this.previewStopState.delete(id);
        // archived/removed → no client cares anymore; drop without an emit
        this.workingWhileBlocked.delete(id);
        this.lastSuppressVisible.delete(id);
        // Phase-1 push-hook tracking (issue #704)
        this.lastHookActivityAt.delete(id);
        this.hookTicks.delete(id);
        this.hookAwaitingInput.delete(id);
      }
    }
    // Phase-1 (issue #704): drop the HookIngest ring buffers for dead sessions too
    // (so they don't grow unbounded by session count). No-op when unwired.
    this.pruneHooks?.(activeIds);
  }

  /** Last-emitted activity signal per running session, for client bootstrap. */
  activitySnapshot(): Record<string, SessionActivity> {
    return Object.fromEntries(this.lastActivity);
  }

  /**
   * Phase-1 push activity (issue #704), fed by HookIngest.onSignal for both
   * `PostToolUse` (`status:"ok"`) and `PostToolUseFailure` (`status:"error"`). Builds
   * a `SessionActivity` from the tool name + a windowed heat-strip tick and routes it
   * through the existing dedup `emitActivity` — the SAME sink the poll path uses, so
   * push + poll never bypass the dedup or oscillate. A `PostToolUse` push carries a
   * REAL tool summary (vs. the interim heartbeat's `summary:null`), so it beats the
   * interim emit on the freshness guard below.
   *
   * No-op when `config.hooksSignals` is off (the sink is never wired in that case, so
   * this is belt-and-suspenders for direct callers/tests). Records `lastHookActivityAt`
   * so `maybeProbe` knows the push path is fresh.
   */
  ingestActivity(
    id: string,
    ev: { toolName?: string; status?: "ok" | "error"; ts?: number },
  ): void {
    if (!config.hooksSignals) return;
    const t = ev.ts ?? this.now();
    // heat-strip: append this tick, window to STRIP_WINDOW_MS (mirror probeTerminalInterim).
    // Skip a duplicate same-ms tick so two events stamped identically dedupe through
    // `emitActivity` (the strip would otherwise differ → spurious re-emit).
    const ticks = this.hookTicks.get(id) ?? [];
    if (ticks[ticks.length - 1] !== t) ticks.push(t);
    const cutoff = t - STRIP_WINDOW_MS;
    const windowed = ticks.filter((ts) => ts >= cutoff);
    this.hookTicks.set(id, windowed);
    // recentErrTs: only the error ticks within the window (a failure feeds error heat
    // via the push path so the freshness guard below can safely suppress the probe's
    // redundant emit without dropping error signal — Finding 3). We don't retain a
    // separate error-tick list across calls (the strip is coarse + windowed), so a
    // single push contributes its own `t` to recentErrTs when it's an error.
    const recentErrTs = ev.status === "error" ? [t] : [];
    this.emitActivity(id, {
      lastActivityTs: t,
      // A real tool name — non-null so it beats the interim `summary:null` heartbeat.
      // We don't have rich tool_input here; the bare tool name is the available summary.
      summary: ev.toolName ?? null,
      recentTs: windowed,
      recentErrTs,
    });
    this.lastHookActivityAt.set(id, t);
  }

  /**
   * Phase-1 push notification (issue #704), fed by HookIngest.onSignal for
   * `Notification` events. An awaiting-input type (see BLOCK_NOTIFICATION_TYPES) sets a
   * marker consumed by `reconcileAgent` to classify THIS tick — surfacing the block
   * ≤ ~1 tick after the agent asks, independent of herdr's latchy `blocked` status.
   * `idle_prompt` clears the marker (idle is handled by herdr mapping; never force a
   * block). Any other type is a no-op here — unknown types are already logged upstream,
   * and an awaiting-input edge we haven't confirmed simply stays on the existing
   * `herdr-blocked → classifyBlocked` fallback (no regression).
   *
   * No-op when `config.hooksSignals` is off.
   */
  ingestNotification(id: string, type: string): void {
    if (!config.hooksSignals) return;
    if (BLOCK_NOTIFICATION_TYPES.has(type)) this.hookAwaitingInput.add(id);
    else if (type === "idle_prompt") this.hookAwaitingInput.delete(id);
    // else: unknown/other type → no-op (dormant; fallback detection unchanged).
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

    // ── transcript-liveness gate: use the transcript only while it's LIVE ──
    // Claude Code 2.1.169 stopped flushing the transcript JSONL live during a
    // session (it now writes only on exit). Worse, a RESUMED session inherits its
    // OLD frozen JSONL, so `parseActivity` returns stale entries → the probe comes
    // back NON-null but its newest record never advances. A naive "both signals
    // null" trigger therefore missed those stale-but-parseable transcripts and
    // stranded the agent on a dead transcript path (its old `recentTs` drain to
    // empty at `now`, so the heartbeat strip renders all-empty and stall detection
    // is effectively disabled).
    //
    // So we don't ask "is the transcript empty?" but "is it being WRITTEN right
    // now?" — does its newest record advance between probes. `newestTs` is the
    // newest of the two signals; `liveWriting` requires an EXISTING baseline AND a
    // strict advance past it. A FIRST sighting (no baseline) is treated as NOT live
    // so a resumed session engages the interim terminal-diff immediately, instead
    // of taking the transcript path once and emitting one stale (already-out-of-
    // window) transcript signal that leaves the heat-strip blank for ~1 cadence.
    // Auto-reactivation is preserved regardless: `lastTranscriptTs` is recorded on
    // EVERY probe (below, before the branch), so a genuinely live-writing transcript
    // advances on its SECOND probe → flips to the transcript path then. The cost is
    // one extra probe (~one cadence) on interim before a live transcript takes over
    // — benign, the interim shows the agent alive meanwhile.
    //
    //  • NOT live-writing (empty transcript OR a frozen/stale one) → derive a
    //    coarse-but-live heartbeat + stall from the herdr "visible" buffer instead.
    //    This adds ONE fresh `visible` read per such agent per probe cadence; to
    //    keep that fan-out off Bun's single loop the read is ASYNC (`readAsync`)
    //    and dispatched fire-and-forget — `tick()` never blocks on it. No
    //    Claude-Code-side hooks; works on already-running agents.
    //  • Live-writing → run the original transcript path (activity emit + stall
    //    liveness gate). First, `resetInterim` clears any interim baseline left by
    //    a prior interim episode, so a LATER re-entry into interim defers cleanly
    //    off a fresh first sample rather than firing off a stale `lastInterimChangeAt`.
    //
    // Flipping to interim during a long live-writing generation gap (no new record
    // for a while) is benign: the terminal-diff still shows the agent alive, and
    // the transcript path resumes the instant a new record lands.
    const newestTs = signals.activity?.lastActivityTs ?? signals.snapshot?.lastTs ?? null;
    const prevTs = this.lastTranscriptTs.get(s.id);
    const liveWriting = newestTs != null && prevTs !== undefined && newestTs > prevTs;
    if (newestTs != null) this.lastTranscriptTs.set(s.id, newestTs);

    if (!liveWriting) {
      void this.probeTerminalInterim(s, t);
      return;
    }

    // transcript is live-writing → clear any stale interim baseline first, then the
    // original transcript-driven activity emit + stall liveness gate.
    this.resetInterim(s.id);

    // ── activity emit (deduped by signal content) ──
    // Phase-1 freshness guard (issue #704, Finding 3): when push activity is fresh, the
    // push path already carries this session with a REAL tool summary (vs. the
    // transcript probe's), so skip the probe's redundant *non-error* activity emit.
    // Stall evaluation below still runs UNCHANGED — hooks only tighten the active path;
    // the pure-generation stall cross-check is untouched. Error heat is NEVER dropped:
    // `PostToolUseFailure` feeds `recentErrTs` via the push path, so suppression is
    // safe — and as a belt-and-suspenders guard, if the probe carries error heat the
    // push hasn't emitted, we still emit it.
    if (signals.activity) {
      if (this.hookActivityFresh(s.id, t) && signals.activity.recentErrTs.length === 0) {
        // fresh push + no probe-side error heat → push path owns the activity emit
      } else {
        this.emitActivity(s.id, signals.activity);
      }
    }

    // ── stall decision: transcript candidate + live-terminal liveness gate ──
    this.evaluateStall(s, t, signals.snapshot);
  }

  /**
   * Clear the interim terminal-diff baseline for a session (its change-baseline,
   * heartbeat ticks, and last visible buffer). Called on every live-writing probe
   * so a later re-entry into the interim path starts from a clean first sample
   * (which defers one cycle) rather than firing off a stale `lastInterimChangeAt`
   * carried over from a PRIOR interim episode (Finding 1).
   *
   * Deliberately does NOT touch `interimInFlight`: that flag self-clears in
   * `probeTerminalInterim`'s `finally`, and an in-flight read completing after a
   * reset simply finds no baseline → behaves as a fresh first sample, which is the
   * correct (defer-not-fire) outcome.
   */
  private resetInterim(id: string): void {
    this.lastInterimChangeAt.delete(id);
    this.interimTicks.delete(id);
    this.lastInterimVisible.delete(id);
  }

  /**
   * Interim heartbeat + stall, derived from the live terminal alone, for when the
   * transcript is not being written live (an empty JSONL, or a resumed session
   * inheriting a frozen old one — see the liveness gate in `maybeProbe`). Reads
   * the visible buffer EXACTLY ONCE — and ASYNCHRONOUSLY, via
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
      // Phase-1 freshness guard (issue #704, Finding 3): when push activity is fresh,
      // the push path carries this session with a REAL tool summary, so skip the
      // interim's redundant `summary:null` heartbeat emit. The interim heartbeat
      // carries no error heat (recentErrTs is always empty here), so suppression can
      // never drop error signal. The stall logic below STILL runs — the interim
      // terminal-freeze stall cross-check is untouched.
      if (changed && !this.hookActivityFresh(id, t)) {
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

  /**
   * Phase-1 (issue #704): is the push (PostToolUse) activity for this session fresh
   * enough that the transcript/interim probe should defer its redundant activity emit?
   * Fresh = a push landed within `2 × probeCheckMs` (two probe cadences — long enough
   * to bridge the gap between two pushes, short enough that a gone-quiet push hands the
   * active path back to the probe). Always false when `hooksSignals` is off (the map
   * stays empty), so the probe emits exactly as today — the fallback.
   */
  private hookActivityFresh(id: string, now: number): boolean {
    if (!config.hooksSignals) return false;
    const at = this.lastHookActivityAt.get(id);
    return at !== undefined && now - at < 2 * this.probeCheckMs;
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

  /**
   * Read + classify a blocked agent at most every `reclassifyMs`; emit only on change.
   * An `awaiting-input` fallback is suppressed (and any announced block cleared once)
   * while the TUI shows an active turn spinner — herdr can latch "blocked" after an
   * answered dialog even though the agent resumed working. Continued suppression
   * additionally requires FRESHNESS: a live spinner ticks its elapsed/token counters,
   * so the visible buffer advances between classify reads — an identical buffer means
   * a wedged turn (or a static tail merely quoting a spinner-like line) and falls
   * through to the normal emit, re-arming the block instead of suppressing forever.
   * The first sighting of an episode gets a one-cadence grace (nothing to compare
   * yet; the common case is a genuinely working spinner). The suppression episode
   * is surfaced as the working-while-blocked display flag: `onWorkingBlocked(id, true)`
   * once on entry; on re-arm (any block that will be emitted) `onWorkingBlocked(id,
   * false)` fires first, then `onBlock`, in the same tick — clients see the flag drop
   * and the block land together.
   */
  private maybeClassify(id: string, term: string): boolean {
    const t = this.now();
    // Throttled this tick → did NOT look (caller may keep an awaiting marker to retry).
    if (t - (this.lastReadAt.get(id) ?? 0) < this.reclassifyMs) return false;
    this.lastReadAt.set(id, t);
    let visible: string;
    let reason: BlockReason;
    try {
      visible = this.herdr.read(term, "visible");
      reason = this.classify(visible);
    } catch (err) {
      console.warn(`[poller] classify failed for ${id}:`, err);
      return false; // best-effort; retry next cadence (didn't classify → didn't look)
    }
    if (reason.shape === "awaiting-input" && hasActiveSpinner(visible)) {
      // herdr can latch "blocked" after an answered dialog; a live spinner means the
      // agent resumed working — clear any announced block instead of emitting the
      // no-evidence fallback. (suppression scoped to awaiting-input only: a genuine
      // menu/y-n dialog must always surface, spinner or not)
      if (this.trySuppressSpinner(id, visible)) return true; // looked this tick (suppressed emit)
      // Freshness gate tripped: the buffer did NOT advance since the last classify
      // read — a wedged turn or a static buffer quoting a spinner-like line, not a
      // live spinner. Fall through to the normal emit so the block re-arms (flag-off
      // before the block, below). `lastSuppressVisible` is deliberately KEPT: while
      // the buffer stays frozen, every subsequent read lands here and dedupes on
      // `lastSig` — deleting it would re-grant first-sighting grace each cadence
      // (suppress/re-arm oscillation).
    } else {
      // Suppression context over (spinner gone, or a genuine menu/y-n dialog) →
      // drop the episode memory so the next spinner sighting gets a fresh grace.
      this.lastSuppressVisible.delete(id);
    }
    const sig = JSON.stringify(reason);
    if (sig === this.lastSig.get(id)) return true; // looked this tick (dedup short-circuit)
    // Re-arm: a block is about to be emitted → end the suppression episode FIRST so
    // the flag-off and the block reach clients in the same tick, in that order.
    if (this.workingWhileBlocked.delete(id)) this.onWorkingBlocked(id, false);
    this.lastSig.set(id, sig);
    this.onBlock(id, reason);
    return true; // looked + classified this tick
  }

  /**
   * Freshness-gated spinner suppression for `maybeClassify`. Records `visible`
   * as the episode baseline and returns true when the buffer is FRESH — first
   * sighting (one-cadence grace; nothing to compare yet) or advanced since the
   * previous read (a live spinner ticking its counters) — having suppressed the
   * fallback: any announced block is cleared once and the working-while-blocked
   * flag turned on (a re-entry after a frozen re-arm lands here too). Returns
   * false when the buffer is FROZEN (identical to the previous read — a wedged
   * turn or a static tail quoting a spinner-like line): no suppression, the
   * caller falls through to the normal emit and re-arms the block.
   */
  private trySuppressSpinner(id: string, visible: string): boolean {
    const prev = this.lastSuppressVisible.get(id);
    this.lastSuppressVisible.set(id, visible);
    if (prev !== undefined && prev === visible) return false; // frozen → re-arm
    if (this.lastSig.has(id)) {
      this.lastSig.delete(id);
      this.onBlock(id, null);
    }
    if (!this.workingWhileBlocked.has(id)) {
      this.workingWhileBlocked.add(id);
      this.onWorkingBlocked(id, true); // once per episode, not per cadence
    }
    return true;
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
    this.lastSuppressVisible.delete(id); // and the spinner-suppression episode baseline
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
    const now = this.now();
    const worktrees = isolated.map((s) => s.worktreePath);
    // Single /proc scan for ALL sessions — never once per session.
    const portsMap = this.previewWiring.scan(worktrees);

    const active: Array<{ sessionId: string; devPort: number }> = [];
    for (const s of isolated) {
      const ports = portsMap.get(s.worktreePath) ?? [];
      const devPort = await this.previewWiring.pick(ports, s.worktreePath);
      if (devPort === null) {
        // Server is gone — clear any escalation state and skip (converge will release it).
        this.previewStopState.delete(s.id);
        continue;
      }

      const idleMs = this.previewWiring.idleStop?.idleMs ?? 0;
      if (idleMs > 0) {
        // FRESH read from store — NOT s.status (stale: store.update doesn't mutate the hydrated object)
        const status = this.store.get(s.id)?.status;
        const idle = this.previewWiring.service.idleSince?.(s.id, now) ?? null;
        if ((status === "idle" || status === "done") && idle !== null && idle >= idleMs) {
          this.escalateIdleStop(s.id, devPort);
          // Keep the session in `active` so the next sweep can observe whether the port
          // died and escalate; the preview clears only when the port actually disappears.
        } else {
          this.previewStopState.delete(s.id); // recovered: viewed again / resumed / not stale → reset episode
        }
      }

      active.push({ sessionId: s.id, devPort });
    }

    // converge releases sessions absent from `active` and ensures those present.
    // onChange (wired in index.ts) emits session:preview on real transitions only.
    this.previewWiring.service.converge(active);
  }

  /** Advance the SIGTERM→SIGKILL→give-up escalation for an idle, no-viewer preview.
   *  First sighting (or a changed devPort) → SIGTERM. Still up after SIGTERM → SIGKILL.
   *  Still up after SIGKILL → log once and stop signalling (leave it bound/viewable).
   *  `idleStop` is guaranteed present (caller checks idleMs > 0, which requires it).
   *
   *  GRACE WINDOW: one step advances per preview sweep, so the gap between SIGTERM
   *  and SIGKILL is ~one sweep cadence (`previewSweepMs`, default 4s) — the dev
   *  server's window to exit gracefully. That's ample for typical dev servers
   *  (Vite/Next/webpack exit promptly on SIGTERM; the SIGKILL is a safety net for
   *  ones that ignore it). The window is coupled to the sweep cadence by design —
   *  lowering `previewSweepMs` shrinks it; if a future caller needs a fixed grace
   *  independent of the cadence, stamp the SIGTERM time in `previewStopState` and
   *  gate the SIGKILL on elapsed-ms instead of next-sweep. */
  private escalateIdleStop(sessionId: string, devPort: number): void {
    const idleStop = this.previewWiring.idleStop!;
    const st = this.previewStopState.get(sessionId);
    if (st && st.devPort === devPort) {
      if (st.level === "term") {
        idleStop.stop(sessionId, "SIGKILL");
        st.level = "kill";
      } else if (st.level === "kill" && !st.gaveUp) {
        console.warn(
          `[preview] idle-stop could not reclaim ${sessionId} on :${devPort} after SIGKILL`,
        );
        st.gaveUp = true;
      }
      // level "kill" && gaveUp → no further signals
    } else {
      idleStop.stop(sessionId, "SIGTERM");
      this.previewStopState.set(sessionId, { devPort, level: "term", gaveUp: false });
    }
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
