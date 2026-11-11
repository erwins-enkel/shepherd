/**
 * Operator schedules (#3469): a ~60 s tick that fires each enabled schedule's latest due slot as a
 * fresh, normal Shepherd session through the shared New Task launch path (`launchTask`), so a
 * scheduled run is held, parked, reviewed and merged exactly like a manual one.
 *
 * Invariants:
 * - CLAIM BEFORE WORK. A slot's `schedule_runs` row is inserted before anything is awaited, so a
 *   crash or restart mid-spawn never fires it twice (the `claimToday` shape from maintain.ts). A
 *   row left `claimed` by a crash stays that way and is shown as interrupted.
 * - OVERLAP SKIPS. While the schedule's previous run is still open — a non-archived session, a
 *   parked held task, or a launch still in flight — a firing is recorded `skipped:overlap`.
 * - Async only: this runs on the server's single Bun loop next to the web terminal.
 */
import type { LaunchOutcome } from "./server";
import type { SessionStore } from "./store";
import type { AgentProvider, StandardCreateInput } from "./types";
import {
  decideFiring,
  decideUsageLimit,
  scheduleUsageWindows,
  latestDueSlot,
  scheduleCreateInput,
  waitingLimitExpiresAt,
  type ScheduleLaunch,
  type ScheduleUsageLimit,
  type Schedule,
  type ScheduleRun,
} from "./schedules-core";

export const SCHEDULE_TICK_MS = 60_000;
/** Run rows older than this are pruned; far past the stale cap, so dedupe never needs them. */
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface ScheduleServiceDeps {
  store: Pick<
    SessionStore,
    | "listSchedules"
    | "listWaitingScheduleRuns"
    | "getSchedule"
    | "claimScheduleRun"
    | "hasScheduleRun"
    | "settleScheduleRun"
    | "getScheduleRun"
    | "bindScheduleBudget"
    | "hasOpenScheduledSession"
    | "listHeldTasks"
    | "pruneScheduleRuns"
  >;
  launch: (
    input: StandardCreateInput,
    opts?: { skipUsageHold?: boolean },
  ) => Promise<LaunchOutcome>;
  usageLimits: Pick<import("./usage-limits").UsageLimitsService, "limits">;
  resolveProvider: (schedule: Schedule) => AgentProvider;
  readyProviders: () => Promise<readonly AgentProvider[]>;
  providerDefaults: (provider: AgentProvider) => Pick<ScheduleLaunch, "model" | "effort">;
  /** The repo's default branch, for a schedule without a pinned base branch. */
  defaultBranch: (repoPath: string) => Promise<string | null>;
  repoRoot: () => string;
  maintenanceActive: () => boolean;
  events: { emit(event: string, data: unknown): void };
  now?: () => number;
  log?: (line: string) => void;
}

export class ScheduleService {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** Schedules with a launch in flight — part of the overlap check, and kept in memory (not a DB
   *  `claimed` row) so a crash can never leave a schedule blocked forever. */
  private readonly inFlight = new Set<string>();
  private ticking = false;
  private lastPrune = 0;

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.info(line));
  }

  /** Evaluate pending waits and every enabled schedule. Single-flight; skipped during maintenance (the
   *  missed slot is caught up by the next tick after it). Never throws. */
  async tick(): Promise<void> {
    if (this.ticking || this.deps.maintenanceActive()) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (now - this.lastPrune >= PRUNE_EVERY_MS) {
        this.deps.store.pruneScheduleRuns(now - RUN_RETENTION_MS);
        this.lastPrune = now;
      }
      for (const s of this.deps.store.listSchedules()) {
        await this.resumeWaiting(s, now);
        if (s.enabled) await this.evaluate(s, now);
      }
    } catch (err) {
      this.log(`[schedules] tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async resumeWaiting(s: Schedule, now: number): Promise<void> {
    for (const run of this.deps.store.listWaitingScheduleRuns(s.id)) {
      if (!s.enabled || now >= waitingLimitExpiresAt(s, run.slotKey)) {
        this.deps.store.settleScheduleRun(s.id, run.slotKey, "skipped:limit-expired", {
          reason: s.enabled ? "limit-expired" : "disabled",
        });
        this.changed(s);
      } else {
        await this.fire(s, run.slotKey, false, true);
      }
    }
  }

  private async evaluate(s: Schedule, now: number): Promise<void> {
    const slot = latestDueSlot(s.days, s.times, now, s.interval);
    const hasRow = slot ? this.deps.store.hasScheduleRun(s.id, slot.slotKey) : false;
    const decision = decideFiring({
      slot,
      baselineAt: s.baselineAt,
      hasRow,
      now,
      interval: s.interval,
    });
    if (decision === "none" || !slot) return;
    if (decision === "stale") {
      if (!this.deps.store.claimScheduleRun(s.id, slot.slotKey, now)) return;
      this.deps.store.settleScheduleRun(s.id, slot.slotKey, "skipped:stale", {
        reason: s.interval ? "missed by more than one interval" : "missed slot older than 12h",
      });
      this.log(`[schedules] ${s.name} ${slot.slotKey}: skipped:stale`);
      this.changed(s);
      return;
    }
    await this.fire(s, slot.slotKey);
  }

  /** Fire a schedule now (the operator's "Run now"), outside the slot cadence. Still subject to
   *  the overlap skip. Returns the run row. */
  async runNow(id: string): Promise<ScheduleRun | null> {
    const s = this.deps.store.getSchedule(id);
    if (!s) return null;
    const slotKey = `manual:${new Date(this.now()).toISOString()}`;
    return this.fire(s, slotKey, true);
  }

  private async fire(
    s: Schedule,
    slotKey: string,
    manual = false,
    waiting = false,
  ): Promise<ScheduleRun | null> {
    const { store } = this.deps;
    // Claim FIRST, synchronously — before any await.
    if (!waiting && !store.claimScheduleRun(s.id, slotKey, this.now()))
      return store.getScheduleRun(s.id, slotKey);
    if (!waiting && this.isOpen(s.id)) {
      store.settleScheduleRun(s.id, slotKey, "skipped:overlap", {
        reason: "previous run still open",
      });
      this.log(`[schedules] ${s.name} ${slotKey}: skipped:overlap (previous run still open)`);
      this.changed(s);
      return store.getScheduleRun(s.id, slotKey);
    }
    const alreadyInFlight = this.inFlight.has(s.id);
    this.inFlight.add(s.id);
    try {
      let provider: AgentProvider | undefined;
      let failover = false;
      const limited = !manual && s.usageLimit !== null;
      if (limited) {
        const decision = await this.limitDecision(s.usageLimit!, this.deps.resolveProvider(s));
        if (!this.recordLimitDecision(s, slotKey, decision, waiting))
          return store.getScheduleRun(s.id, slotKey);
        provider = decision.usage.provider;
        failover = decision.failover;
      } else if (waiting) {
        store.settleScheduleRun(s.id, slotKey, "claimed", { usage: null });
      }
      // A waiting row itself is not open. Only check overlap after its limit allows a start;
      // this call owns the inFlight entry, which still excludes concurrent manual firings.
      if (waiting && (alreadyInFlight || this.isOpen(s.id, false))) {
        store.settleScheduleRun(s.id, slotKey, "skipped:overlap", {
          reason: "previous run still open",
        });
        return store.getScheduleRun(s.id, slotKey);
      }
      const launchSchedule = failover
        ? {
            ...s,
            launch: {
              ...s.launch,
              agentProvider: provider!,
              ...this.deps.providerDefaults(provider!),
            },
          }
        : s;
      await this.launch(launchSchedule, slotKey, provider, limited, failover);
    } catch (err) {
      store.settleScheduleRun(s.id, slotKey, "error", { reason: String(err) });
    } finally {
      if (!alreadyInFlight) this.inFlight.delete(s.id);
      this.changed(s);
    }
    return store.getScheduleRun(s.id, slotKey);
  }

  /** Choose only this run's provider, using one usage snapshot and the same thresholds. */
  private async limitDecision(limit: ScheduleUsageLimit, provider: AgentProvider) {
    const limits = this.deps.usageLimits.limits(this.now());
    const primary = decideUsageLimit(limit, provider, scheduleUsageWindows(limits, provider));
    if (primary.allowed || limit.onMismatch !== "otherProvider")
      return { ...primary, failover: false };
    const other = provider === "claude" ? "codex" : "claude";
    const alternate = decideUsageLimit(limit, other, scheduleUsageWindows(limits, other));
    if (alternate.allowed && (await this.deps.readyProviders()).includes(other))
      return { ...alternate, failover: true };
    return { ...primary, failover: false };
  }

  /** Persist the admission decision before launch; edits during diagnostics can cancel a wait. */
  private recordLimitDecision(
    s: Schedule,
    slotKey: string,
    decision: Awaited<ReturnType<ScheduleService["limitDecision"]>>,
    waiting: boolean,
  ): boolean {
    const { store } = this.deps;
    if (waiting && store.getScheduleRun(s.id, slotKey)?.outcome !== "waiting:limit") return false;
    if (waiting && this.now() >= waitingLimitExpiresAt(s, slotKey)) {
      store.settleScheduleRun(s.id, slotKey, "skipped:limit-expired", { reason: "limit-expired" });
      return false;
    }
    const hold = !decision.allowed && s.usageLimit!.onMismatch === "wait";
    const expired = hold && this.now() >= waitingLimitExpiresAt(s, slotKey);
    store.settleScheduleRun(
      s.id,
      slotKey,
      decision.allowed
        ? "claimed"
        : expired
          ? "skipped:limit-expired"
          : hold
            ? "waiting:limit"
            : "skipped:limit",
      {
        reason: expired ? "limit-expired" : decision.reason,
        usage: decision.usage,
      },
    );
    return decision.allowed;
  }

  private isOpen(id: string, includeInFlight = true): boolean {
    return (
      (includeInFlight && this.inFlight.has(id)) ||
      this.deps.store.hasOpenScheduledSession(id) ||
      this.deps.store.listHeldTasks().some((h) => h.input.scheduleId === id)
    );
  }

  private async launch(
    s: Schedule,
    slotKey: string,
    provider?: AgentProvider,
    skipUsageHold = false,
    failover = false,
  ): Promise<void> {
    const { store } = this.deps;
    const base = s.launch.baseBranch ?? (await this.deps.defaultBranch(s.repoPath));
    if (!base) {
      store.settleScheduleRun(s.id, slotKey, "error", { reason: "no default branch" });
      return;
    }
    const input = scheduleCreateInput(s, base, this.deps.repoRoot());
    if (!input.ok) {
      store.settleScheduleRun(s.id, slotKey, "error", { reason: input.error });
      this.log(`[schedules] ${s.name} ${slotKey}: error ${input.error}`);
      return;
    }
    const out = await this.deps.launch(
      {
        ...input.value,
        ...(provider && { agentProvider: provider }),
        scheduleId: s.id,
        scheduleRun: { slotKey, tokenBudget: s.tokenBudget ?? null },
      },
      { skipUsageHold },
    );
    if (out.kind === "spawned") {
      store.settleScheduleRun(s.id, slotKey, failover ? "spawned:failover" : "spawned", {
        sessionId: out.session.id,
      });
      store.bindScheduleBudget(out.session.id, s.id, slotKey, s.tokenBudget ?? null);
      this.log(`[schedules] ${s.name} ${slotKey}: spawned ${out.session.desig}`);
    } else if (out.kind === "held") {
      store.settleScheduleRun(s.id, slotKey, "held", { reason: out.held.reason });
      this.log(`[schedules] ${s.name} ${slotKey}: held (${out.held.reason})`);
    } else {
      const reason = out.error instanceof Error ? out.error.message : String(out.error);
      store.settleScheduleRun(s.id, slotKey, "error", { reason });
      this.log(`[schedules] ${s.name} ${slotKey}: error ${reason}`);
    }
  }

  private changed(s: Schedule): void {
    this.deps.events.emit("schedules:changed", { repoPath: s.repoPath });
  }
}
