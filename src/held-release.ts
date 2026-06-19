/**
 * Auto-release sweeper for usage-aware task holding (#825).
 *
 * When called from the 30s tick, drains held_tasks FIFO whenever usage has
 * dropped below the configured threshold. If disabled, tasks are released
 * regardless of current usage (they were held while enabled; disabled means
 * the operator no longer wants the gate — release everything).
 */
import type { SessionStore } from "./store";
import type { CreateSessionInput } from "./types";
import type { UsageLimits } from "./usage-limits";

export interface HeldReleaseDeps {
  store: Pick<SessionStore, "listHeldTasks" | "removeHeldTask" | "countHeldTasks" | "list">;
  service: { create(input: CreateSessionInput): Promise<unknown> };
  usageLimits: { limits(now: number): UsageLimits };
  events: { emit(event: string, data: unknown): void };
}

/**
 * Releases held tasks FIFO when usage has dropped below holdPct. Bounded per call.
 *
 * When `cfg.enabled` is false the threshold is ignored and held tasks are released
 * unconditionally — the operator turned the gate off, so nothing should remain blocked.
 */
export async function releaseHeldTasks(
  deps: HeldReleaseDeps,
  cfg: { enabled: boolean; holdPct: number },
  now: number,
  maxPerTick = 3,
): Promise<{ released: number }> {
  if (cfg.enabled) {
    const lim = deps.usageLimits.limits(now);
    const maxPct = Math.max(lim.session5h?.pct ?? 0, lim.week?.pct ?? 0);
    if (maxPct >= cfg.holdPct) return { released: 0 };
  }

  const tasks = deps.store.listHeldTasks();
  let released = 0;

  for (const task of tasks) {
    if (released >= maxPerTick) break;
    try {
      await deps.service.create(task.input);
      deps.store.removeHeldTask(task.id);
      released++;
    } catch (err) {
      console.warn("[held] spawn failed for task", task.id, err);
      // Head-of-line blocking: a task whose service.create throws (e.g. repo deleted
      // between hold and release) stays at the queue head and re-blocks every tick
      // until the operator explicitly discards it via the TopBar held-tasks popover.
      // The discard action is the escape hatch — there is no automatic skip.
      break; // on failure, leave the row and stop — don't lose or skip remaining tasks
    }
  }

  if (released > 0) {
    deps.events.emit("held:changed", { count: deps.store.countHeldTasks() });
  }

  return { released };
}
