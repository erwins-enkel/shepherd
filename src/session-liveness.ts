import { isStalled, type ActivitySnapshot, type StallConfig } from "./stall";
import { STRIP_WINDOW_MS, type SessionActivity } from "./activity-signal";

/** Both transcript-derived signals from a single read (mirrors the poller's probe result). */
export type TranscriptSignals = {
  snapshot: ActivitySnapshot | null;
  activity: SessionActivity | null;
};

export type LivenessVerdict = "fire" | "clearStall" | "clearBroad" | "none";

export interface LivenessOutcome {
  verdict: LivenessVerdict;
  /** Present only when verdict === "fire": the raw visible buffer, so the poller can call
   *  its unchanged fireStall(id, visible) (which computes tailLines itself). */
  visible?: string;
  /** Interim heartbeat to emit (poller routes it through emitActivity). null/absent = none. */
  activity?: SessionActivity | null;
  /** True when an interim read COMPLETED (assessed) → the poller runs its stale-sig guard. */
  clearStaleBlock?: boolean;
}

export interface LivenessDeps {
  /** Read the terminal's visible buffer synchronously (rare candidate confirm). */
  read: (term: string) => string;
  /** Read the terminal's visible buffer asynchronously (off-loop interim probe). */
  readAsync: (term: string) => Promise<string>;
  /** A GETTER (not a value) so a future runtime stallCfg change would propagate. */
  stallCfg: () => StallConfig;
}

export type LivenessStep = { outcome: LivenessOutcome } | { pending: Promise<LivenessOutcome> };

/**
 * Per-session liveness state machine — the transcript-vs-interim routing, both
 * liveness diffs (transcript `lastVisible` + interim terminal-diff), and the interim
 * heat-strip. One instance per session; a fresh instance behaves as a fresh first
 * sighting on every signal (matches the poller's prior map-miss semantics). Computes
 * a verdict only — it does not emit anything and does not own `lastSig`/fire-once
 * dedup; those stay with the poller's caller.
 */
export class SessionLiveness {
  /** Newest transcript-record ts seen on the PREVIOUS probe — the liveness baseline
   *  that decides transcript-vs-interim each probe. A probe whose newest record
   *  advanced past this is "live-writing" (use the transcript); one that didn't
   *  (empty, or a resumed session inheriting a frozen old JSONL) falls to the
   *  interim terminal-diff. First sighting (no baseline) counts as NOT live so a
   *  resumed agent engages the interim path immediately. */
  private lastTranscriptTs: number | undefined;
  /** Last visible-terminal buffer for the transcript-path liveness diff. A turn
   *  still generating keeps its spinner/elapsed/token counter ticking, so the
   *  buffer changes between probes; a wedged or idle turn leaves it frozen. */
  private lastVisible: string | undefined;
  /** Interim terminal-diff state — used whenever the transcript is NOT being
   *  written live. Kept separate from `lastVisible` (which belongs to the
   *  transcript path's gate) so the two liveness diffs never trample each other;
   *  this whole cluster is reset (`resetInterim`) the moment the transcript starts
   *  live-writing again. */
  private lastInterimVisible: string | undefined;
  /** Last time the interim visible buffer changed; the interim stall baseline. */
  private lastInterimChangeAt: number | undefined;
  /** Heartbeat ticks (ms epochs of probes where the visible buffer changed),
   *  windowed to STRIP_WINDOW_MS — drives the interim heat-strip. */
  private interimTicks: number[] = [];
  /** True while an async interim terminal read is in flight — a slow read must
   *  not let the next cadence pile a second read on top; skip while pending. */
  private interimInFlight = false;

  constructor(private readonly deps: LivenessDeps) {}

  /** Route + compute the liveness verdict for one probe. Transcript path resolves
   *  synchronously ({outcome}); interim path returns a module-owned Promise ({pending}). */
  step(term: string, signals: TranscriptSignals, now: number, hookFresh: boolean): LivenessStep {
    const newestTs = signals.activity?.lastActivityTs ?? signals.snapshot?.lastTs ?? null;
    const prevTs = this.lastTranscriptTs; // undefined on first sighting
    const liveWriting = newestTs != null && prevTs !== undefined && newestTs > prevTs;
    if (newestTs != null) this.lastTranscriptTs = newestTs; // recorded on EVERY probe

    if (!liveWriting) return { pending: this.probeInterim(term, now, hookFresh) };

    this.resetInterim(); // clear stale interim baseline
    return { outcome: this.evaluateTranscript(term, signals.snapshot, now) };
  }

  /** Reset the transcript diff baseline (lastVisible). Called by the poller's clearBlock. */
  clearTranscriptBaseline(): void {
    this.lastVisible = undefined;
  }

  /**
   * Confirm or clear a stall for a running agent from its transcript snapshot.
   * No candidate (transcript progressing) → clearBroad (poller's clearBlock).
   * A candidate reads the live terminal once (for the tail and the liveness diff).
   * The diff applies ONLY to pure-generation candidates (`!pending`): a hung
   * command (pending past the ceiling) bypasses the gate and fires directly.
   */
  private evaluateTranscript(
    term: string,
    snap: ActivitySnapshot | null,
    now: number,
  ): LivenessOutcome {
    const cfg = this.deps.stallCfg();
    if (!snap || !isStalled(snap, now, cfg)) return { verdict: "clearBroad" };
    let visible: string;
    try {
      visible = this.deps.read(term);
    } catch {
      return { verdict: "none" }; // can't assess this cycle — lastVisible stays untouched
    }
    if (!snap.pending && this.sampleTerminal(visible) !== "frozen")
      return { verdict: "clearStall" };
    return { verdict: "fire", visible };
  }

  /**
   * Record the current visible buffer as the new liveness baseline and report how
   * it compares to the previous sample. "fresh" on the first probe of an episode —
   * nothing to compare against yet, so the caller defers one cycle.
   */
  private sampleTerminal(visible: string): "fresh" | "moving" | "frozen" {
    const prev = this.lastVisible;
    this.lastVisible = visible;
    if (prev === undefined) return "fresh";
    return visible === prev ? "frozen" : "moving";
  }

  /**
   * Interim heartbeat + stall, derived from the live terminal alone, for when the
   * transcript is not being written live. Reads the visible buffer EXACTLY ONCE —
   * ASYNCHRONOUSLY — dispatched fire-and-forget from `step`; an `interimInFlight`
   * guard skips a fresh dispatch while a prior read is still pending. `t` and
   * `hookFresh` are the probe-DISPATCH values captured in the closure — they must
   * NOT be recomputed at read-completion time.
   */
  private async probeInterim(
    term: string,
    t: number,
    hookFresh: boolean,
  ): Promise<LivenessOutcome> {
    if (this.interimInFlight) return { verdict: "none" }; // skip: no read, no clearStaleBlock
    this.interimInFlight = true;
    try {
      let visible: string;
      try {
        visible = await this.deps.readAsync(term);
      } catch {
        return { verdict: "none" }; // read failed: no clearStaleBlock
      }
      // read succeeded → this probe ASSESSED → clearStaleBlock:true on all paths below.
      const prev = this.lastInterimVisible;
      const changed = prev !== undefined && visible !== prev;
      let activity: SessionActivity | null = null;
      if (changed && !hookFresh) {
        // heat-strip tick (dispatch `t`)
        this.interimTicks.push(t);
        const cutoff = t - STRIP_WINDOW_MS;
        const windowed = this.interimTicks.filter((ts) => ts >= cutoff);
        this.interimTicks = windowed;
        activity = {
          lastActivityTs: windowed[windowed.length - 1]!,
          summary: null,
          recentTs: windowed,
          recentErrTs: [],
        };
      }
      const cfg = this.deps.stallCfg();
      let verdict: LivenessVerdict;
      if (changed) {
        this.lastInterimChangeAt = t;
        verdict = "clearStall";
      } else if (this.lastInterimChangeAt === undefined) {
        // first sample (no baseline yet) → defer one cycle, never fire blind.
        this.lastInterimChangeAt = t;
        verdict = "none";
      } else if (t - this.lastInterimChangeAt >= cfg.stallMs) {
        verdict = "fire";
      } else {
        verdict = "none";
      }
      this.lastInterimVisible = visible;
      return {
        verdict,
        visible: verdict === "fire" ? visible : undefined,
        activity,
        clearStaleBlock: true,
      };
    } finally {
      this.interimInFlight = false;
    }
  }

  /**
   * Clear the interim terminal-diff baseline (change-baseline, heartbeat ticks, last
   * visible buffer). Called on every live-writing probe so a later re-entry into the
   * interim path starts from a clean first sample (defers one cycle) rather than
   * firing off a stale `lastInterimChangeAt` carried over from a PRIOR interim episode.
   * Deliberately does NOT touch `interimInFlight`: that flag self-clears in
   * `probeInterim`'s `finally`, and an in-flight read completing after a reset simply
   * finds no baseline → behaves as a fresh first sample (defer-not-fire).
   */
  private resetInterim(): void {
    this.lastInterimChangeAt = undefined;
    this.interimTicks = [];
    this.lastInterimVisible = undefined;
  }
}
