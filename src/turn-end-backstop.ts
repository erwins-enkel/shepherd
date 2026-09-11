// Turn-end backstop — recovers the "agent finished a turn" edge when herdr never reports `done`.
//
// herdr's `done` is a "finished, and nobody has looked yet" NOTIFICATION state, not a lifecycle
// state: viewing the pane clears it back to `idle`, permanently (verified live — `herdr agent focus`
// on a `done` pane flips it to `idle` and it stays there; `agent read` and the HUD's
// `terminal session control` attach do NOT clear it). Shepherd keys "the agent finished a turn" on
// `done` in exactly two places:
//   - plan-gate.ts shouldConsiderOnSettle() — fires the FIRST plan review on `done`; on `idle` only
//     when a prior gate already said `changes_requested`, which a first draft never has.
//   - autopilot.ts handle() — calls onDone() only on `done`.
// So an operator watching the pane as the agent finishes destroys the only trigger, and nothing
// re-checks: the session hangs forever. The plan gate concentrates the failure because its directive
// makes the agent ask questions via AskUserQuestion, so the operator is on that tab exactly when the
// plan lands.
//
// This service does NOT change status semantics, mapState(), or shouldConsiderOnSettle(): the fast
// path stays as-is and still fires instantly. The backstop only does work when the fast path already
// failed, so its settle threshold costs latency ONLY in the broken case.
//
// It borrows RecapService's / BuildQueueReminderService's settled-idle debounce STRUCTURE. Both
// dispatch targets are already fully self-guarding, which is what makes re-driving them safe:
//   - PlanGateService.consider() short-circuits on gate-off, phase not `planning`, a review in
//     flight or mid-spawn, an already-`approved` gate, a missing/empty plan, an unchanged plan hash,
//     and a spawn already refused for this exact plan text. A redundant call is a free no-op.
//   - AutopilotService.onDone() runs through eligible(), which stands down on archived, planning
//     phase, autopilot disabled, non-isolated codex, pending MCP OAuth, paused, complete, an open PR
//     outside full-auto, and a classify already in flight.

import { isSettledIdle } from "./recap-core";
import type { SessionStore } from "./store";
import type { Session, SessionStatus } from "./types";

/** Matches RecapService and BuildQueueReminderService — the house settled-idle dwell. */
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

/** Per-session lifetime cap on recovery ATTEMPTS (runaway guard). */
const DEFAULT_MAX_ATTEMPTS = 3;

/** The two statuses that mean "the agent is at rest": herdr's view-clearable `done` and the `idle`
 *  it decays into. The pair {@link isSettledIdle} accepts — kept as a named predicate here because
 *  this service needs a THREE-state view (active / resting-not-settled / resting-settled) that a
 *  single boolean can't express. */
function isResting(status: SessionStatus): boolean {
  return status === "idle" || status === "done";
}

interface DebounceEntry {
  /** epoch ms when the current resting episode began; null whenever the session isn't resting. */
  settledSince: number | null;
  /** true once this episode's turn end was recovered (reset when the session re-activates). */
  firedThisEpisode: boolean;
  /** true once the REAL `done` edge was routed for this episode — set by {@link
   *  TurnEndBackstopService.markDelivered}. A healthy session must never pay for a redundant
   *  autopilot classify, so a delivered episode is never backstopped. Cleared on re-activation so
   *  the next turn's edge re-marks it. */
  delivered: boolean;
  /** true once we've observed this session NOT resting. The evidence gate that makes a restart
   *  safe: a session already at rest when the process starts was never observed active, so it is
   *  never backstopped and no restart storm of classify spawns can happen. Mirrors
   *  BuildQueueReminderService's `sawRunning`. Deliberately NOT reset per episode — it is evidence
   *  about the session, not about the current rest. */
  sawActive: boolean;
  /** lifetime recovery ATTEMPTS for this session, successful or not (runaway guard). Counting
   *  failures too is deliberate: a rejection leaves `firedThisEpisode` unset so a TRANSIENT failure
   *  retries on the next tick, and without a bounded attempt count a persistently throwing dispatch
   *  would retry every sweep forever. */
  attemptCount: number;
}

interface Deps {
  store: Pick<SessionStore, "list">;
  /** Re-drive the plan gate for a planning-phase session. Idempotent; see the header note. */
  considerPlan: (s: Session) => Promise<unknown>;
  /** Re-drive autopilot's turn-end handler. Self-guarding via eligible(); see the header note. */
  autopilotDone: (id: string) => Promise<void>;
  now?: () => number;
  idleThresholdMs?: number;
  maxAttempts?: number;
}

export class TurnEndBackstopService {
  private now: () => number;
  private idleThresholdMs: number;
  private maxAttempts: number;
  private debounce = new Map<string, DebounceEntry>();
  /** True while a sweep is in flight. The sweep awaits each dispatch, so a slow one can still be
   *  running when the next tick fires; without this an overlapping sweep would re-pass readyToFire
   *  for the same session (firedThisEpisode is only set once the dispatch resolves) and deliver a
   *  duplicate. The tick is DROPPED rather than queued — this is an idle-debounced recovery, so the
   *  next tick re-evaluates from fresh state. Mirrors BuildQueueReminderService's guard. */
  private sweeping = false;

  constructor(private deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Drop a session's debounce state (call on archive). */
  forget(id: string): void {
    this.debounce.delete(id);
  }

  /**
   * Record that the REAL `done` status edge was routed for this session, so the backstop stands
   * down for the current resting episode. Fed from the `session:status` subscriber in index.ts.
   *
   * Belt-and-braces rather than load-bearing — a redundant `considerPlan` is free — but it keeps a
   * healthy session from paying an autopilot classify it doesn't need: onDone() can legitimately
   * classify and then leave the session idle (e.g. an `unknown` verdict that just surfaces), which
   * without this flag the backstop would re-drive every episode.
   */
  markDelivered(id: string): void {
    this.entry(id).delivered = true;
  }

  private entry(id: string): DebounceEntry {
    let e = this.debounce.get(id);
    if (!e) {
      e = {
        settledSince: null,
        firedThisEpisode: false,
        delivered: false,
        sawActive: false,
        attemptCount: 0,
      };
      this.debounce.set(id, e);
    }
    return e;
  }

  /** End the current resting episode. `sawActive`/`attemptCount` survive — they are per-session
   *  evidence, not per-episode state. */
  private resetEpisode(e: DebounceEntry): void {
    e.settledSince = null;
    e.firedThisEpisode = false;
    e.delivered = false;
  }

  /**
   * Periodic recovery pass, driven by the shared 15s sweep interval in index.ts. Advances each
   * active session's resting debounce and re-drives the turn-end consumer that missed its edge.
   * Never throws: a dispatch rejection is logged and leaves the episode unburned so the next tick
   * retries, bounded by the per-session attempt cap (see {@link recover}).
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return; // prior sweep still dispatching — skip this tick
    this.sweeping = true;
    try {
      const now = this.now();
      const live = new Set<string>();
      for (const s of this.deps.store.list({ activeOnly: true })) {
        live.add(s.id);
        await this.considerSession(s, now);
      }
      // Forget sessions that are no longer active/listed.
      for (const id of [...this.debounce.keys()]) {
        if (!live.has(id)) this.debounce.delete(id);
      }
    } finally {
      this.sweeping = false; // a thrown store error must not wedge the sweep off
    }
  }

  /** Advance one session's debounce and recover its turn end if it's overdue. */
  private async considerSession(s: Session, now: number): Promise<void> {
    const e = this.entry(s.id);

    // Active (running/blocked) → the episode is over. `blocked` counts as active: a session waiting
    // on the operator has not finished its turn.
    if (!isResting(s.status)) {
      e.sawActive = true;
      this.resetEpisode(e);
      return;
    }

    // First tick at rest only stamps the clock — per the once-on-settled-idle house rule, since
    // sessions go idle after every steer and firing on the first tick would run mid-work.
    if (e.settledSince === null) {
      e.settledSince = now;
      return;
    }

    if (!isSettledIdle(s.status, now - e.settledSince, this.idleThresholdMs)) return;
    if (!this.readyToFire(e)) return;
    await this.recover(s, e);
  }

  /** Whether this resting episode is owed a recovered turn end. */
  private readyToFire(e: DebounceEntry): boolean {
    return (
      !e.firedThisEpisode && // once per episode
      !e.delivered && // the real edge already fired
      e.sawActive && // evidence gate → restart-safe
      e.attemptCount < this.maxAttempts // runaway guard
    );
  }

  /**
   * Dispatch the missed edge to the one consumer that owns this session's phase. Routing by phase
   * (rather than calling both and leaning on autopilot's planning stand-down) keeps the intent
   * legible: while `planning`, the plan gate owns the session and autopilot is suppressed anyway.
   *
   * A rejection does NOT burn the EPISODE — `firedThisEpisode` stays unset, so a transient failure
   * retries on the next tick. The ATTEMPT is still counted, which is what bounds a persistently
   * throwing dispatch: without that, a dependency failing every time would be re-driven every 15s
   * forever.
   */
  private async recover(s: Session, e: DebounceEntry): Promise<void> {
    const phase = s.planPhase ?? "none";
    e.attemptCount++;
    try {
      if (s.planPhase === "planning") await this.deps.considerPlan(s);
      else await this.deps.autopilotDone(s.id);
    } catch (err) {
      console.warn(`[turn-end-backstop] recovery failed for ${s.id} (phase=${phase}):`, err);
      return;
    }
    e.firedThisEpisode = true;
    // Logged on success only (never per tick), so the previously-invisible rate of lost turn-end
    // edges is measurable in ~/.shepherd/shepherd.log.
    console.log(
      `[turn-end-backstop] recovered lost turn-end id=${s.id} phase=${phase} ` +
        `status=${s.status} attempt=${e.attemptCount}`,
    );
  }
}
