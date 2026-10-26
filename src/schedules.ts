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
import type { StandardCreateInput } from "./types";
import {
  decideFiring,
  latestDueSlot,
  scheduleCreateInput,
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
    | "getSchedule"
    | "claimScheduleRun"
    | "hasScheduleRun"
    | "settleScheduleRun"
    | "getScheduleRun"
    | "hasOpenScheduledSession"
    | "listHeldTasks"
    | "pruneScheduleRuns"
  >;
  launch: (input: StandardCreateInput) => Promise<LaunchOutcome>;
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

  /** Evaluate every enabled schedule once. Single-flight; skipped during herdr maintenance (the
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
        if (s.enabled) await this.evaluate(s, now);
      }
    } catch (err) {
      this.log(`[schedules] tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(s: Schedule, now: number): Promise<void> {
    const slot = latestDueSlot(s.days, s.times, now);
    const hasRow = slot ? this.deps.store.hasScheduleRun(s.id, slot.slotKey) : false;
    const decision = decideFiring({ slot, baselineAt: s.baselineAt, hasRow, now });
    if (decision === "none" || !slot) return;
    if (decision === "stale") {
      if (!this.deps.store.claimScheduleRun(s.id, slot.slotKey, now)) return;
      this.deps.store.settleScheduleRun(s.id, slot.slotKey, "skipped:stale", {
        reason: "missed slot older than 12h",
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
    return this.fire(s, slotKey);
  }

  private async fire(s: Schedule, slotKey: string): Promise<ScheduleRun | null> {
    const { store } = this.deps;
    // Claim FIRST, synchronously — before any await.
    if (!store.claimScheduleRun(s.id, slotKey, this.now()))
      return store.getScheduleRun(s.id, slotKey);
    if (this.isOpen(s.id)) {
      store.settleScheduleRun(s.id, slotKey, "skipped:overlap", {
        reason: "previous run still open",
      });
      this.log(`[schedules] ${s.name} ${slotKey}: skipped:overlap (previous run still open)`);
      this.changed(s);
      return store.getScheduleRun(s.id, slotKey);
    }
    this.inFlight.add(s.id);
    try {
      await this.launch(s, slotKey);
    } catch (err) {
      store.settleScheduleRun(s.id, slotKey, "error", { reason: String(err) });
    } finally {
      this.inFlight.delete(s.id);
      this.changed(s);
    }
    return store.getScheduleRun(s.id, slotKey);
  }

  private isOpen(id: string): boolean {
    return (
      this.inFlight.has(id) ||
      this.deps.store.hasOpenScheduledSession(id) ||
      this.deps.store.listHeldTasks().some((h) => h.input.scheduleId === id)
    );
  }

  private async launch(s: Schedule, slotKey: string): Promise<void> {
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
    const out = await this.deps.launch({ ...input.value, scheduleId: s.id });
    if (out.kind === "spawned") {
      store.settleScheduleRun(s.id, slotKey, "spawned", { sessionId: out.session.id });
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
