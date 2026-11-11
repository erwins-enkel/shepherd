import type { SessionStore } from "./store";
import type { Session, UsagePause } from "./types";
import { SessionUsageRollup } from "./usage";
import type { UsageLimits } from "./usage-limits";

/** Requested pauses already exclude new automatic work; no shelving/group semantics. */
export function isUsagePaused(s: Pick<Session, "usagePause"> | null | undefined): boolean {
  return s?.usagePause != null;
}

export function isAutomationQuiet(s: Pick<Session, "usagePause" | "shelved">): boolean {
  return isUsagePaused(s) || s.shelved === true;
}

export class UsagePauseResumeCanceled extends Error {}

/** Automatic teardown lost its permission while awaiting other work. */
export class UsagePauseArchiveCanceled extends Error {
  constructor() {
    super("automatic archive canceled by usage pause");
  }
}

type Window = UsagePause["windows"][number];
interface Deps {
  store: Pick<
    SessionStore,
    | "get"
    | "list"
    | "getSchedule"
    | "setUsagePause"
    | "usagePauseOptedOut"
    | "scheduleBudget"
    | "updateScheduleTokens"
  >;
  limits: () => UsageLimits;
  rollup?: SessionUsageRollup;
  stop: (id: string, text: string, since: number) => Promise<boolean>;
  resume: (id: string, text: string, since: number) => Promise<boolean>;
  events: { emit(event: string, data: unknown): void };
  isBackgroundBusy?: (id: string) => boolean;
  now?: () => number;
}

/** Notify both session clients and schedule lists after an atomic store mutation. */
export function publishUsagePause(
  s: Session,
  pause: UsagePause | null,
  events: Deps["events"] | undefined,
): void {
  if (!s.usagePause && !pause) return;
  events?.emit("session:usage-pause", { id: s.id, usagePause: pause });
  events?.emit("schedules:changed", { repoPath: s.repoPath });
}

export class SchedulePauseService {
  private inFlight = new Set<string>();
  private now: () => number;
  private rollup: SessionUsageRollup;
  constructor(private deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.rollup = deps.rollup ?? new SessionUsageRollup();
  }

  private source(s: Session) {
    const limits = this.deps.limits();
    return (s.agentProvider ?? "claude") === "claude"
      ? limits
      : limits.providers?.find((p) => p.provider === "codex");
  }

  private window(s: Session, key: Window) {
    const source = this.source(s);
    return key === "week" ? source?.week : source?.session5h;
  }

  private blocking(s: Session, stop: number): Window[] {
    return (["week", "5h"] as const).filter((key) => {
      const window = this.window(s, key);
      return window != null && window.pct >= stop;
    });
  }

  private absent(s: Session, key: Window): boolean {
    return (
      key === "5h" &&
      (s.agentProvider ?? "claude") === "claude" &&
      this.deps.limits().observed?.session5hAbsent === true
    );
  }

  private observedWindow(key: Window) {
    const observed = this.deps.limits().observed;
    return key === "week" ? observed?.week : observed?.session5h;
  }

  private reset(s: Session, windows: Window[]): number | null {
    // Computed Claude caps may contain inferred anchors. Only provider observations establish
    // reset deadlines; percentages still use the same computed gauges as schedule admission.
    const times = windows
      .filter((key) => !this.absent(s, key))
      .map((key) =>
        (s.agentProvider ?? "claude") === "claude"
          ? this.observedWindow(key)?.resetAt
          : this.window(s, key)?.resetAt,
      );
    return times.length && times.every((t) => t != null && Number.isFinite(t) && t > this.now())
      ? Math.max(...(times as number[]))
      : null;
  }

  private save(s: Session, pause: UsagePause | null): void {
    this.deps.store.setUsagePause(s.id, pause);
    publishUsagePause(s, pause, this.deps.events);
  }

  private budget(s: Session): Session {
    if ((s.agentProvider ?? "claude") !== "claude") return s;
    const budget = this.deps.store.scheduleBudget(s.id);
    if (
      !budget ||
      budget.ended ||
      (s.usagePause?.reason === "budget" && s.usagePause.phase === "paused")
    )
      return s;
    const usage = this.rollup.refreshSessionSync(s, this.now());
    if (!usage) return s;
    const tokensUsed = usage.input + usage.cacheWrite + usage.output;
    if (tokensUsed !== budget.tokensUsed) {
      this.deps.store.updateScheduleTokens(s.id, tokensUsed);
      this.deps.events.emit("schedules:changed", { repoPath: s.repoPath });
    }
    if (tokensUsed < budget.tokenBudget) return s;
    const pause: UsagePause =
      s.usagePause?.reason === "budget"
        ? { ...s.usagePause, tokensUsed }
        : {
            reason: "budget",
            phase: "requested",
            since: Math.max(this.now(), (s.usagePause?.since ?? -1) + 1),
            stopSteerSent: false,
            tokenBudget: budget.tokenBudget,
            tokensUsed,
            resumeAt: null,
            stopPct: 0,
            windows: [],
          };
    this.save(s, pause);
    return { ...s, usagePause: pause };
  }

  private request(s: Session, hardLimit = false): Session {
    s = this.budget(s);
    if (s.usagePause || !s.scheduleId || this.deps.store.usagePauseOptedOut(s.id)) return s;
    const limit = this.deps.store.getSchedule(s.scheduleId)?.usageLimit;
    if (!limit?.pauseAtStop) return s;
    let windows = this.blocking(s, limit.stopPct);
    if (!windows.length && !hardLimit) return s;
    // A CLI-confirmed hard halt is authoritative even before telemetry catches up.
    if (!windows.length) windows = ["week", "5h"];
    const pause: UsagePause = {
      phase: "requested",
      since: this.now(),
      stopPct: limit.stopPct,
      resumeAt: this.reset(s, windows),
      windows,
      stopSteerSent: false,
    };
    this.save(s, pause);
    return { ...s, usagePause: pause };
  }

  /** Synchronous: call before router snapshots and any independent turn-end consumers. */
  onStatus(id: string, status: string): void {
    if (status !== "idle" && status !== "done") return;
    let s = this.deps.store.get(id);
    if (!s || s.status === "archived" || this.deps.isBackgroundBusy?.(id)) return;
    s = this.request(s);
    if (s.usagePause?.phase === "requested") this.save(s, { ...s.usagePause, phase: "paused" });
  }

  onHalt(id: string, reason: string | null): void {
    if (reason !== "usage_limit") return;
    let s = this.deps.store.get(id);
    if (!s || s.status === "archived") return;
    s = this.request(s, true);
    if (s.usagePause?.phase === "requested") this.save(s, { ...s.usagePause, phase: "paused" });
  }

  async tick(): Promise<void> {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (this.inFlight.has(s.id)) continue;
      this.inFlight.add(s.id);
      try {
        await this.check(s);
      } catch (err) {
        console.warn("[schedule-pause] check:", err);
      } finally {
        this.inFlight.delete(s.id);
      }
    }
  }

  private current(id: string, since: number): Session | null {
    const s = this.deps.store.get(id);
    return s && s.status !== "archived" && s.usagePause?.since === since ? s : null;
  }

  private async check(initial: Session): Promise<void> {
    const fresh = this.deps.store.get(initial.id);
    if (!fresh || fresh.status === "archived") return;
    let s = this.request(fresh, fresh.haltReason === "usage_limit");
    if (!s.usagePause) return;
    if (s.haltReason === "usage_limit") this.onHalt(s.id, s.haltReason);
    else this.onStatus(s.id, s.status);
    s = this.deps.store.get(s.id)!;
    const pause = s.usagePause!;
    if (!pause || s.shelved) return;
    if (pause.phase === "requested") return this.sendStop(s, pause);
    if (pause.reason === "budget") {
      this.rollup.forget(s.id);
      return;
    }
    await this.resumePaused(s, pause);
  }

  private async sendStop(s: Session, pause: UsagePause): Promise<void> {
    if ((s.agentProvider ?? "claude") === "claude" && !pause.stopSteerSent) {
      const delivered = await this.deps.stop(
        s.id,
        pause.reason === "budget"
          ? `Shepherd: this scheduled run reached its token budget (${pause.tokenBudget}). Finish the step you're on, then stop — don't start a new step.`
          : `Shepherd: the usage stop for this scheduled run (${pause.stopPct} %) is reached. Finish the step you're on, then stop and wait — don't start a new step. Shepherd resumes you after the usage window resets.`,
        pause.since,
      );
      const current = this.current(s.id, pause.since);
      if (delivered && current?.usagePause?.phase === "requested")
        this.save(current, { ...current.usagePause, stopSteerSent: true });
    }
  }

  private async resumePaused(s: Session, pause: UsagePause): Promise<void> {
    // A pane that started working by itself must not receive a second continue prompt.
    if (
      (s.status === "running" && s.haltReason !== "usage_limit") ||
      this.deps.isBackgroundBusy?.(s.id)
    )
      return;
    const now = this.now();
    if (pause.resumeAt === null) {
      const reset = this.reset(s, pause.windows);
      if (reset === null) return;
      pause = { ...pause, resumeAt: reset };
      this.save(s, pause);
    }
    if (pause.resumeAt! > now) return;
    if (!this.usageAllowsResume(s, pause, now)) return;
    const delivered = await this.deps.resume(
      s.id,
      "Shepherd: the usage window has reset. Continue where you left off.",
      pause.since,
    );
    const current = this.current(s.id, pause.since);
    if (delivered && current && current.usagePause?.reason !== "budget") this.save(current, null);
  }

  private usageAllowsResume(s: Session, pause: UsagePause, now: number): boolean {
    const source = this.source(s);
    if (!source) return false;
    const observedOnly =
      (s.agentProvider ?? "claude") === "claude" && !source.week && !source.session5h;
    if (source.stale && !observedOnly) return false;
    const blocking = this.blocking(s, pause.stopPct);
    if (blocking.length) {
      const resumeAt = this.reset(s, blocking);
      if (resumeAt !== pause.resumeAt || blocking.join() !== pause.windows.join())
        this.save(s, { ...pause, resumeAt, windows: blocking });
      return false;
    }
    return this.hasResetEvidence(s, pause, now);
  }

  private hasResetEvidence(s: Session, pause: UsagePause, now: number): boolean {
    // Expired/missing telemetry cannot prove that the triggering windows reset.
    if (
      pause.windows.some((key) => {
        const w =
          this.window(s, key) ??
          ((s.agentProvider ?? "claude") === "claude" ? this.observedWindow(key) : null);
        return !this.absent(s, key) && (!w || w.resetAt == null || w.resetAt <= now);
      })
    )
      return false;
    if ((s.agentProvider ?? "claude") === "claude") {
      if (
        pause.windows.some((key) => {
          if (this.absent(s, key)) return false;
          const sample = this.observedWindow(key);
          return (
            !sample ||
            sample.scrapedAt < pause.resumeAt! ||
            sample.resetAt <= now ||
            sample.pct >= pause.stopPct
          );
        })
      )
        return false;
    } else {
      const source = this.source(s);
      if (!source?.week && !source?.session5h) return false;
    }
    return true;
  }
}
