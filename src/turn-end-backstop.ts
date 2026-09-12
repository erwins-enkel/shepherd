// Turn-end backstop — recovers the "agent finished a turn" edge when herdr never reports `done`.
//
// herdr's `done` is a "finished, and nobody has looked yet" NOTIFICATION state, not a lifecycle
// state: viewing the pane clears it back to `idle`, permanently (verified live — `herdr agent focus`
// on a `done` pane flips it to `idle` and it stays there; `agent read` and the HUD's
// `terminal session control` attach do NOT clear it). Shepherd keys "the agent finished a turn" on
// `done` in exactly three places:
//   - plan-gate.ts shouldConsiderOnSettle() — fires the FIRST plan review on `done`; on `idle` only
//     when a prior gate already said `changes_requested`, which a first draft never has.
//   - autopilot.ts handle() — calls onDone() only on `done`.
//   - push.ts attachPush() — the "agent finished its turn" notification, gated on `status === "done"`.
// So an operator watching the pane as the agent finishes destroys the only trigger, and nothing
// re-checks: the session hangs forever and its finish push is silently dropped (#2267). The plan
// gate concentrates the failure because its directive makes the agent ask questions via
// AskUserQuestion, so the operator is on that tab exactly when the plan lands.
//
// This service does NOT change status semantics, mapState(), or shouldConsiderOnSettle(): the fast
// path stays as-is and still fires instantly. The backstop only does work when the fast path already
// failed, so its settle threshold costs latency ONLY in the broken case.
//
// It borrows RecapService's / BuildQueueReminderService's settled-idle debounce STRUCTURE. All
// dispatch targets are already fully self-guarding, which is what makes re-driving them safe:
//   - PlanGateService.consider() short-circuits on gate-off, phase not `planning`, a review in
//     flight or mid-spawn, an already-`approved` gate, a missing/empty plan, an unchanged plan hash,
//     and a spawn already refused for this exact plan text. A redundant call is a free no-op.
//   - AutopilotService.onDone() runs through eligible(), which stands down on archived, planning
//     phase, autopilot disabled, missing conversation identity, pending MCP OAuth, paused, complete, an open PR
//     outside full-auto, and a classify already in flight.
//   - push.notify() drops a send inside its own cooldown window and honors each device's category
//     selection, on top of the `delivered` stand-down below.

import { isSettledIdle } from "./recap-core";
import type { SessionStore } from "./store";
import type { Session, SessionStatus } from "./types";

/** Matches RecapService and BuildQueueReminderService — the house settled-idle dwell. */
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;

/** Per-session, PER-CONSUMER cap on consecutive failed dispatches (runaway guard). Deliberately not
 *  a lifetime cap on recoveries: a session whose pane the operator keeps open loses its turn-end
 *  edge on EVERY turn, so a lifetime cap would let it hang (or go un-notified) again after the third
 *  turn. Re-driving once per resting episode is exactly what a healthy `done` edge already does
 *  every turn — the thing that actually needs bounding is a dispatch that throws every time. */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** The turn-end consumers this service re-drives, each tracked separately per resting episode. */
type Consumer = "push" | "phase";

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
  /** the consumers whose recovery has landed for THIS episode (reset when the session re-activates).
   *  Tracked per consumer, not as one flag: a pass dispatches both, so a single flag would mean a
   *  failing plan-gate/autopilot spawn replays an ALREADY-SENT push on the next 15s tick. */
  fired: Record<Consumer, boolean>;
  /** true once the REAL `done` edge was routed for this episode — set by {@link
   *  TurnEndBackstopService.markDelivered}. A healthy session must never pay for a redundant
   *  autopilot classify or a DUPLICATE finish notification, so a delivered episode is never
   *  backstopped. Cleared on re-activation so the next turn's edge re-marks it.
   *
   *  Deliberately keyed on the status EDGE, not on the push having actually reached a device: a
   *  send suppressed by push.notify()'s cooldown or by a device muting the `agent` category is the
   *  existing intended behavior, and re-driving it here would defeat both. */
  delivered: boolean;
  /** true once we've observed this session NOT resting. The evidence gate that makes a restart
   *  safe: a session already at rest when the process starts was never observed active, so it is
   *  never backstopped and no restart storm of classify spawns can happen. Mirrors
   *  BuildQueueReminderService's `sawRunning`. Deliberately NOT reset per episode — it is evidence
   *  about the session, not about the current rest. */
  sawActive: boolean;
  /** consecutive REJECTED dispatches per consumer, reset to 0 by that consumer's next success. A
   *  rejection leaves the consumer's `fired` flag unset so a TRANSIENT failure retries on the next
   *  tick; this streak is what stops a persistently throwing dispatch from being re-driven every
   *  15s forever.
   *
   *  Counted per consumer, like `fired`: a plan-gate spawn that throws every time must not also
   *  silence the finish push, which is a different dependency that is working fine.
   *
   *  Like `sawActive` these survive re-activation — a dependency that has failed every pass does
   *  not become healthy because the agent started another turn, and only a success clears it. */
  failStreak: Record<Consumer, number>;
}

interface Deps {
  store: Pick<SessionStore, "list">;
  /** Re-drive the plan gate for a planning-phase session. Idempotent; see the header note. */
  considerPlan: (s: Session) => Promise<unknown>;
  /** Re-drive autopilot's turn-end handler. Self-guarding via eligible(); see the header note. */
  autopilotDone: (id: string) => Promise<void>;
  /** Send the "agent finished its turn" push the lost `done` edge never triggered (#2267).
   *  Phase-agnostic, because the real edge in attachPush() is too. */
  notifyDone: (id: string) => Promise<unknown>;
  now?: () => number;
  idleThresholdMs?: number;
  maxConsecutiveFailures?: number;
}

export class TurnEndBackstopService {
  private now: () => number;
  private idleThresholdMs: number;
  private maxConsecutiveFailures: number;
  private debounce = new Map<string, DebounceEntry>();
  /** True while a sweep is in flight. The sweep awaits each dispatch, so a slow one can still be
   *  running when the next tick fires; without this an overlapping sweep would re-pass readyToFire
   *  for the same session (a consumer's `fired` flag is only set once its dispatch resolves) and
   *  deliver a duplicate. The tick is DROPPED rather than queued — this is an idle-debounced
   *  recovery, so the next tick re-evaluates from fresh state. Mirrors
   *  BuildQueueReminderService's guard. */
  private sweeping = false;

  constructor(private deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  /** Drop a session's debounce state (call on archive). */
  forget(id: string): void {
    this.debounce.delete(id);
  }

  /**
   * Record that the REAL `done` status edge was routed for this session, so the backstop stands
   * down for the current resting episode. Fed from the `session:status` subscriber in index.ts.
   *
   * Load-bearing for the push consumer — without it a healthy session would be notified twice, by
   * attachPush() on the edge and again by this sweep two minutes later. For the other two it also
   * keeps a healthy session from paying an autopilot classify it doesn't need: onDone() can
   * legitimately classify and then leave the session idle (e.g. an `unknown` verdict that just
   * surfaces), which without this flag the backstop would re-drive every episode.
   */
  markDelivered(id: string): void {
    this.entry(id).delivered = true;
  }

  /**
   * Record that the session is ACTIVE again — the RELIABLE arming path, fed from the poller's 1 Hz
   * `session:status` running/blocked transitions (wired in index.ts). The sweep's own 15s sample is
   * kept as the coarse fallback but cannot carry this alone: `status` is a point-in-time LEVEL, not
   * a "recently-active" latch, so a working burst that starts and finishes between two sweeps is
   * invisible to it (the same problem #1617 fixed for BuildQueueReminderService's `markRan`).
   *
   * All three consequences of missing a burst are real, and the third is the dangerous one:
   *  - `sawActive` never arms, so {@link readyToFire} is false forever and the backstop silently
   *    does nothing — for exactly the short turns a plan-gate question round produces;
   *  - the PREVIOUS turn's `delivered` flag survives into the next episode, suppressing a genuinely
   *    lost `done` edge so the session hangs anyway;
   *  - `settledSince` is carried over, so a session that resumed work seconds ago already reads as
   *    settled past the threshold and fires MID-TURN against a half-written plan — precisely what
   *    the once-on-settled-idle house rule exists to prevent.
   */
  markActive(id: string): void {
    const e = this.entry(id);
    e.sawActive = true;
    this.resetEpisode(e);
  }

  private entry(id: string): DebounceEntry {
    let e = this.debounce.get(id);
    if (!e) {
      e = {
        settledSince: null,
        fired: { push: false, phase: false },
        delivered: false,
        sawActive: false,
        failStreak: { push: 0, phase: 0 },
      };
      this.debounce.set(id, e);
    }
    return e;
  }

  /** End the current resting episode. `sawActive`/`failStreak` survive — they are per-session
   *  evidence, not per-episode state. */
  private resetEpisode(e: DebounceEntry): void {
    e.settledSince = null;
    e.fired = { push: false, phase: false };
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
    // on the operator has not finished its turn. Delegates to {@link markActive} so the sweep's
    // coarse sample and the 1 Hz event path can never diverge.
    if (!isResting(s.status)) {
      this.markActive(s.id);
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

  /** Whether this resting episode still owes at least one consumer a recovered turn end. */
  private readyToFire(e: DebounceEntry): boolean {
    return (
      !e.delivered && // the real edge already fired
      e.sawActive && // evidence gate → restart-safe
      (this.owes(e, "push") || this.owes(e, "phase"))
    );
  }

  /** Whether one consumer still owes this episode a dispatch: not yet fired (once per consumer per
   *  episode) and not written off by its own runaway guard. */
  private owes(e: DebounceEntry, c: Consumer): boolean {
    return !e.fired[c] && e.failStreak[c] < this.maxConsecutiveFailures;
  }

  /**
   * Dispatch the missed edge to every consumer this episode still owes.
   *
   * The push is phase-agnostic (attachPush() does not look at the phase either) and goes FIRST: it
   * is the cheapest and the most time-sensitive of the three, and a plan-gate or autopilot spawn
   * failure must not swallow the operator's notification.
   *
   * The other dispatch is routed BY PHASE rather than calling both and leaning on autopilot's
   * planning stand-down, which keeps the intent legible: while `planning`, the plan gate owns the
   * session and autopilot is suppressed anyway.
   *
   * A rejection does NOT burn that consumer's episode flag, so a transient failure retries on the
   * next tick — and neither the flag nor the failure streak is shared, so one consumer can neither
   * replay the other's success nor silence it by failing. What bounds a persistently throwing
   * dispatch is its own `failStreak` against `maxConsecutiveFailures`.
   */
  private async recover(s: Session, e: DebounceEntry): Promise<void> {
    const phase = s.planPhase ?? "none";
    const fired: Consumer[] = [];

    if (this.owes(e, "push")) {
      if (await this.run(s.id, phase, e, "push", () => this.deps.notifyDone(s.id)))
        fired.push("push");
    }

    if (this.owes(e, "phase")) {
      const dispatch = () =>
        s.planPhase === "planning" ? this.deps.considerPlan(s) : this.deps.autopilotDone(s.id);
      if (await this.run(s.id, phase, e, "phase", dispatch)) fired.push("phase");
    }

    if (fired.length === 0) return;
    // Logged on success only (never per tick), so the previously-invisible rate of lost turn-end
    // edges is measurable in ~/.shepherd/shepherd.log.
    console.log(
      `[turn-end-backstop] recovered lost turn-end id=${s.id} phase=${phase} ` +
        `status=${s.status} consumers=${fired.join(",")}`,
    );
  }

  /** Run one consumer's dispatch and record the outcome against that consumer alone. Returns
   *  whether it landed; never throws, so the sweep goes on to the next consumer and next session. */
  private async run(
    id: string,
    phase: string,
    e: DebounceEntry,
    c: Consumer,
    dispatch: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await dispatch();
    } catch (err) {
      e.failStreak[c]++;
      console.warn(
        `[turn-end-backstop] ${c} recovery failed for ${id} ` +
          `(phase=${phase}, consecutive=${e.failStreak[c]}):`,
        err,
      );
      return false;
    }
    e.fired[c] = true;
    e.failStreak[c] = 0;
    return true;
  }
}
