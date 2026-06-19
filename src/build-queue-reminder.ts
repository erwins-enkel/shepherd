// Build-queue reconciliation nudge — the settled-idle BACKSTOP to the deterministic
// forward-fill cascade in store.setBuildStepStatus.
//
// Forward-fill keeps the queue fresh whenever the agent posts ANY step transition. This
// service covers the one shape forward-fill cannot: an agent that posted NOTHING at all,
// so the queue is stuck "all pending" while real work has happened. When such a session
// settles idle, we inject ONE reminder steer asking it to post its progress (which then
// forward-fills). It is best-effort, not a guarantee — re-asking an agent is the same lever
// it already ignored, so correctness rests on forward-fill, not on this nudge.
//
// It borrows RecapService's settled-idle debounce STRUCTURE only, not its side-effect
// profile: recap spawns a separate read-only agent, whereas this steers the LIVE pane.
// Steering re-activates the session, so the guards below are load-bearing:
//   - only `idle` is eligible — never `done` (would wake a FINISHED agent → autopilot
//     continuation / PR attempts / token spend), never `running` (live work in progress).
//   - settled (not first idle tick, per the once-on-settled-idle house rule).
//   - `sawRunning` evidence gate — an approved+all-pending queue is indistinguishable from
//     "just approved, not yet started", so we only nudge after observing the agent actually
//     run, which also avoids colliding with the APPROVE_STEER "Begin now" steer.
//   - once per idle episode + a per-session lifetime cap (runaway guard).
// Agent-facing text is fixed English (precedent: APPROVE_STEER, AUTOPILOT_DIRECTIVE).

import type { SessionStore } from "./store";
import type { BuildQueue, SessionStatus } from "./types";

const DEFAULT_IDLE_THRESHOLD_MS = 120_000;
const DEFAULT_MAX_NUDGES = 3;

/** The reconcile reminder injected into a drifted, settled-idle session. */
export const RECONCILE_STEER =
  "🔄 Your build-queue step statuses look out of date — they don't reflect your actual " +
  "progress (the queue still shows steps pending that you've moved past). Reconcile them now " +
  "via the build-queue API: mark the step you're currently on `active` and any finished steps " +
  "`done`. Marking a later step automatically completes the earlier ones, so a single update " +
  "is enough. Then carry on.";

/**
 * Pure drift test. A queue is "drifted" when it's approved with work outstanding but no step
 * is signalled in-progress: at least one `pending` step and zero `active` steps. A
 * well-behaved agent keeps the current step `active` while working and ends with no `pending`
 * steps, so settled-idle-with-pending-but-nothing-active is the drift window.
 */
export function isQueueDrifted(q: BuildQueue): boolean {
  if (!q.approved || q.steps.length === 0) return false;
  return q.steps.some((s) => s.status === "pending") && !q.steps.some((s) => s.status === "active");
}

interface DebounceEntry {
  /** epoch ms when the current idle episode began; null whenever the session isn't idle. */
  idleSince: number | null;
  /** true once a reminder fired in the current idle episode (reset when it re-activates). */
  firedThisEpisode: boolean;
  /** true once we've observed the session actually running since we began tracking it. */
  sawRunning: boolean;
  /** lifetime reminders sent to this session (runaway guard). */
  nudgeCount: number;
}

interface Deps {
  store: Pick<SessionStore, "list" | "getBuildQueue">;
  /** Inject a steer into a session's live pane. Returns false for an unknown id / dead pane. */
  steer: (id: string, text: string) => boolean;
  now?: () => number;
  idleThresholdMs?: number;
  maxNudges?: number;
}

export class BuildQueueReminderService {
  private now: () => number;
  private idleThresholdMs: number;
  private maxNudges: number;
  private debounce = new Map<string, DebounceEntry>();

  constructor(private deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.maxNudges = deps.maxNudges ?? DEFAULT_MAX_NUDGES;
  }

  /** Drop a session's debounce state (call on archive). */
  forget(id: string): void {
    this.debounce.delete(id);
  }

  private entry(id: string): DebounceEntry {
    let e = this.debounce.get(id);
    if (!e) {
      e = { idleSince: null, firedThisEpisode: false, sawRunning: false, nudgeCount: 0 };
      this.debounce.set(id, e);
    }
    return e;
  }

  /** Mark the current (or next) idle episode as not-yet-fired and not idle. */
  private resetEpisode(e: DebounceEntry): void {
    e.idleSince = null;
    e.firedThisEpisode = false;
  }

  /**
   * Periodic auto-fire. For each active session with an approved, non-empty queue, advance the
   * settled-idle debounce and nudge once per episode when the queue is drifted. May surface a
   * synchronous store (SQLite) error; the caller guards it so the timer can't die.
   */
  sweep(): void {
    const now = this.now();
    const live = new Set<string>();
    for (const s of this.deps.store.list({ activeOnly: true })) {
      live.add(s.id);
      this.considerSession(s.id, s.status, now);
    }
    // Forget sessions that are no longer active/listed.
    for (const id of [...this.debounce.keys()]) {
      if (!live.has(id)) this.debounce.delete(id);
    }
  }

  /** Advance one session's debounce and nudge it if it's a drifted, settled-idle queue. */
  private considerSession(id: string, status: SessionStatus, now: number): void {
    const q = this.deps.store.getBuildQueue(id);
    // No approved queue yet (or none authored) → nothing to reconcile; drop any state.
    if (!q.approved || q.steps.length === 0) {
      this.debounce.delete(id);
      return;
    }
    const e = this.entry(id);

    // Only `idle` is eligible. `running` records work-seen; everything else (done/blocked/
    // archived) is skipped without steering. All non-idle states reset the idle episode.
    if (status !== "idle") {
      if (status === "running") e.sawRunning = true;
      this.resetEpisode(e);
      return;
    }

    // idle: settle first (the first idle tick is not "settled", per the house rule).
    if (e.idleSince === null) {
      e.idleSince = now;
      return;
    }
    if (!this.readyToNudge(e, q, now)) return;

    // If the steer doesn't land (dead pane), leave state untouched so the next sweep retries.
    if (this.deps.steer(id, RECONCILE_STEER)) {
      e.firedThisEpisode = true;
      e.nudgeCount++;
    }
  }

  /** Whether a settled-idle session is eligible for a reconcile nudge this episode. */
  private readyToNudge(e: DebounceEntry, q: BuildQueue, now: number): boolean {
    if (e.idleSince === null) return false;
    return (
      now - e.idleSince >= this.idleThresholdMs && // settled long enough
      !e.firedThisEpisode && // once per episode
      e.sawRunning && // evidence of work → not the just-approved shape
      e.nudgeCount < this.maxNudges && // runaway guard
      isQueueDrifted(q)
    );
  }
}
