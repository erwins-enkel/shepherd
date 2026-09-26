// Plan-review kick off Claude Code's `Stop` hook.
//
// The plan gate's first review keys on herdr's `done` edge (shouldConsiderOnSettle), which in
// practice no longer arrives — every recent planning session was only reviewed by the 2-minute
// TurnEndBackstopService. The `Stop` hook does arrive reliably at every turn end, so it is the
// fast path here.
//
// A `Stop` is not a guaranteed turn end: an operator-configured Stop hook can block it and keep
// the agent working. So the kick waits a short quiet dwell and is cancelled by any sign of work in
// between (later tool activity, a permission prompt, a running/blocked status). On fire it only
// re-checks phase + status; PlanGateService.consider() already dedupes everything else (in-flight,
// approved, unchanged plan hash, refused spawn), so a redundant kick is a free no-op.

import type { SessionStore } from "./store";
import type { Session } from "./types";

const DEFAULT_DWELL_MS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface Deps {
  store: Pick<SessionStore, "get">;
  /** PlanGateService.consider — self-guarding; see the header note. */
  considerPlan: (s: Session) => Promise<unknown>;
  dwellMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  warn?: (...args: unknown[]) => void;
}

export class PlanStopTrigger {
  private timers = new Map<string, TimerHandle>();
  private dwellMs: number;
  private setTimer: (fn: () => void, ms: number) => TimerHandle;
  private clearTimer: (h: TimerHandle) => void;
  private warn: (...args: unknown[]) => void;

  constructor(private deps: Deps) {
    this.dwellMs = deps.dwellMs ?? DEFAULT_DWELL_MS;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
    this.warn = deps.warn ?? ((...args) => console.warn(...args));
  }

  /** A `Stop` hook landed for this session: (re)arm its quiet dwell. */
  onStop(id: string): void {
    this.cancel(id);
    this.timers.set(
      id,
      this.setTimer(() => this.fire(id), this.dwellMs),
    );
  }

  /** The session showed work after its `Stop` — drop the pending kick. */
  cancel(id: string): void {
    const h = this.timers.get(id);
    if (h === undefined) return;
    this.clearTimer(h);
    this.timers.delete(id);
  }

  /** Drop a session's state (call on archive). */
  forget(id: string): void {
    this.cancel(id);
  }

  private fire(id: string): void {
    this.timers.delete(id);
    const s = this.deps.store.get(id);
    if (!s || s.planPhase !== "planning") return;
    if (s.status === "running" || s.status === "blocked") return;
    void this.deps.considerPlan(s).catch((err) => this.warn("[plan-stop-trigger] consider:", err));
  }
}
