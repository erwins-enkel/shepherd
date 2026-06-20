// ReadyNotifier — the "ready-after-5s" push evaluator for reducedPushMode (#896).
//
// While reduced-push mode is on, fire the `ready` push exactly once when a session
// has sat continuously in the ready set for ≥READY_DWELL_MS. Four subtleties:
//
//  - Dwell IS the debounce. We don't push the instant a session turns ready —
//    PR/CI state churns; a green flicker that immediately reverts shouldn't ping
//    the operator. The session must hold ready for the full dwell window; leaving
//    the set deletes the dwell entry, so re-entry restarts a fresh 5s.
//
//  - Seed-on-arm (boot + runtime toggle-on). On the first armed tick we mark every
//    currently-ready session as already-notified WITHOUT firing. This kills the
//    boot burst (a restart would otherwise re-announce everything ready) and the
//    runtime mode-flip burst (turning the toggle ON shouldn't replay the backlog).
//    Turning the mode OFF clears all state, so the next ON re-seeds.
//
//  - Warm-up (cold git cache). prPoller's snapshot is empty right after a session
//    is first seen; isReadyForNotify can briefly read a session as "ready" only
//    because git state hasn't loaded. We hold off firing until a session has been
//    seen for READY_WARMUP_MS (one fast prPoller cycle) so the predicate runs on
//    warm state, not a cold cache. firstSeen is per-session (pruned when a session
//    disappears, so a re-created id warms up afresh).
//
//  - Send-gating. We mark a dwell entry `notified` ONLY when notify() reports a
//    real send (returns true). push.notify returns false when the app is focused
//    (isActive), in cooldown, or has no devices — in those cases the ping is
//    deferred, not dropped: subsequent ticks keep trying, and the moment a send
//    lands we mark notified and stop. (Mirrors attachUsagePush's send-gating.)
import type { Session } from "./types";
import type { GitState } from "./forge/types";
import type { NotifyInput } from "./push";
import { isReadyForNotify } from "./ready-stage";

/** Continuous time a session must hold "ready" before the push fires. */
export const READY_DWELL_MS = 5000;
/** Time a session must have been seen before it can fire (covers the cold git cache).
 *  One prPoller fast-poll cycle. */
export const READY_WARMUP_MS = 15000;

export interface ReadyNotifierDeps {
  listSessions: () => Session[]; // store.list({ activeOnly: true })
  workingBlocked: () => Record<string, boolean>; // poller.workingBlockedSnapshot()
  gitSnapshot: () => Record<string, GitState>; // prPoller.snapshot()
  reviewingIds: () => string[]; // critic UNION plan-gate ids
  notify: (input: NotifyInput) => Promise<boolean>; // push.notify
  reducedMode: () => boolean; // () => config.reducedPushMode
  now?: () => number; // default Date.now
  intervalMs?: number; // default 1000
  // Injectable ONLY so the evaluator's tests stay focused on the dwell/seed/
  // send-gating state machine (the predicate itself is covered by ready-stage.test.ts):
  isReady?: (
    s: Session,
    git: GitState | undefined,
    isReviewing: (id: string) => boolean,
    workingBlocked: Record<string, boolean>,
    now: number,
  ) => boolean; // default isReadyForNotify
}

interface DwellEntry {
  since: number;
  notified: boolean;
}

export class ReadyNotifier {
  private readonly deps: ReadyNotifierDeps;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly isReady: NonNullable<ReadyNotifierDeps["isReady"]>;

  private dwell = new Map<string, DwellEntry>();
  private firstSeen = new Map<string, number>();
  private armed = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ReadyNotifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 1000;
    this.isReady = deps.isReady ?? isReadyForNotify;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // notify awaits I/O; never overlap two ticks
    this.ticking = true;
    try {
      if (!this.deps.reducedMode()) {
        this.resetOff();
        return;
      }

      const now = this.now();
      const sessions = this.deps.listSessions();
      const wb = this.deps.workingBlocked();
      const git = this.deps.gitSnapshot();
      const reviewing = new Set(this.deps.reviewingIds());
      const isReviewing = (id: string) => reviewing.has(id);

      this.syncSeen(sessions, now);

      // Seed on arm (off→on transition / first armed tick): mark currently-ready
      // sessions as already-notified and fire nothing this tick.
      if (!this.armed) {
        this.seedOnArm(sessions, git, isReviewing, wb, now);
        return;
      }

      // Normal evaluation. Sequential awaits (no Promise.all) so `ticking` genuinely
      // serializes I/O; fine for the session counts involved.
      for (const s of sessions) {
        await this.evaluateSession(s, git, isReviewing, wb, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Mode OFF resets everything; the next ON re-seeds. */
  private resetOff(): void {
    this.dwell.clear();
    this.firstSeen.clear();
    this.armed = false;
  }

  /** Prune state for vanished sessions, then record the warm-up baseline for new ones. */
  private syncSeen(sessions: Session[], now: number): void {
    const activeIds = new Set(sessions.map((s) => s.id));
    for (const id of [...this.dwell.keys()]) if (!activeIds.has(id)) this.dwell.delete(id);
    for (const id of [...this.firstSeen.keys()]) if (!activeIds.has(id)) this.firstSeen.delete(id);
    // Warm-up baseline from first sighting.
    for (const s of sessions) if (!this.firstSeen.has(s.id)) this.firstSeen.set(s.id, now);
  }

  /** First armed tick: mark currently-ready sessions already-notified, fire nothing. */
  private seedOnArm(
    sessions: Session[],
    git: Record<string, GitState>,
    isReviewing: (id: string) => boolean,
    wb: Record<string, boolean>,
    now: number,
  ): void {
    this.armed = true;
    for (const s of sessions) {
      if (this.isReady(s, git[s.id], isReviewing, wb, now)) {
        this.dwell.set(s.id, { since: now, notified: true });
      }
    }
  }

  /** Per-session ready/entry/dwell/warm-up/fire decision; awaits the send when it fires. */
  private async evaluateSession(
    s: Session,
    git: Record<string, GitState>,
    isReviewing: (id: string) => boolean,
    wb: Record<string, boolean>,
    now: number,
  ): Promise<void> {
    const ready = this.isReady(s, git[s.id], isReviewing, wb, now);
    const entry = this.dwell.get(s.id);
    if (!ready) {
      if (entry) this.dwell.delete(s.id); // resets dwell + notified
      return;
    }
    if (!entry) {
      this.dwell.set(s.id, { since: now, notified: false });
      return;
    }
    if (entry.notified) return;
    if (now - entry.since < READY_DWELL_MS) return; // dwell not met
    if (now - (this.firstSeen.get(s.id) ?? now) < READY_WARMUP_MS) return; // warm-up not met

    const sent = await this.deps.notify({
      kind: "ready",
      sessionId: s.id,
      tag: `ready:${s.id}`,
      name: s.name ?? s.id,
      cooldownKey: `ready:${s.id}`,
    });
    if (sent) entry.notified = true; // ONLY mark on a real send
  }
}
