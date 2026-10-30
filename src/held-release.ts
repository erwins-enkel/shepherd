import { config } from "./config";
/**
 * Auto-release sweeper for usage-aware task holding (#825).
 *
 * When called from the 30s tick, drains held_tasks FIFO whenever usage has
 * dropped below the configured threshold. If disabled, tasks are released
 * regardless of current usage (they were held while enabled; disabled means
 * the operator no longer wants the gate — release everything).
 *
 * Every release is a new session, so it also passes the heavy slot's start gate: under memory
 * pressure it stays held and waits its turn in the start queue (src/start-queue-core.ts).
 */
import type { GitForge } from "./forge/types";
import { claimLinkedIssue } from "./server";
import type { SessionStore } from "./store";
import type { CreateSessionInput, Session } from "./types";
import type { UsageLimits } from "./usage-limits";
import { afterGateOpen, type PrSnapshot, type TaskDepsStore } from "./task-deps";
import { taskStartEntry, type StartEntry } from "./start-queue-core";

export interface HeldReleaseDeps {
  codexCapacity?: (taskId?: string) => Promise<boolean>;
  store: Pick<
    SessionStore,
    "listHeldTasks" | "removeHeldTask" | "countHeldTasks" | "markHeldDispatchStarted"
  >;
  service: { create(input: CreateSessionInput): Promise<Session> };
  usageLimits: { limits(now: number): UsageLimits };
  events: { emit(event: string, data: unknown): void };
  /** Resolve the forge for a repo so a released task's linked issue can be re-claimed. */
  resolveForge?: (repoDir: string) => GitForge | null;
  /** `--after` gate (#2589): session reads + live PR snapshot. Absent → predecessors never land,
   *  so an `after` task only leaves via the operator's spawn/discard. */
  taskDeps?: { store: TaskDepsStore; prGit: PrSnapshot };
  /** The memory-pressure start gate (HeavySlotService); absent → never holds. */
  startGate?: { admitStart(entry: StartEntry, queued?: boolean): Promise<boolean> };
}

async function heldCapacityAvailable(
  deps: HeldReleaseDeps,
  task: ReturnType<HeldReleaseDeps["store"]["listHeldTasks"]>[number],
  cfg: { enabled: boolean; holdPct: number; autoRelease: boolean },
  now: number,
): Promise<boolean> {
  if ((task.input.agentProvider ?? config.defaultAgentProvider) === "codex")
    return deps.codexCapacity?.(task.id) ?? true;
  if (!cfg.enabled) return true;
  // A dependency or memory hold is not the operator's manual-release queue: once its predecessor
  // landed or the pressure eased it only waits for usage headroom.
  if (!cfg.autoRelease && task.reason !== "after" && task.reason !== "memory") return false;
  const lim = deps.usageLimits.limits(now);
  return Math.max(lim.session5h?.pct ?? 0, lim.week?.pct ?? 0) < cfg.holdPct;
}

/** The host-wide start gate. A refusal holds every task behind this one too, which queues them in
 *  held order. */
async function startAdmitted(
  deps: HeldReleaseDeps,
  task: ReturnType<HeldReleaseDeps["store"]["listHeldTasks"]>[number],
): Promise<boolean> {
  if (!deps.startGate) return true;
  return deps.startGate.admitStart(taskStartEntry(task.id, task.input), task.reason === "memory");
}

function predecessorReady(deps: HeldReleaseDeps, afterSessionId: string | undefined): boolean {
  const t = deps.taskDeps;
  return t ? afterGateOpen(t.store, t.prGit, afterSessionId) : false;
}

/**
 * Releases held tasks FIFO when usage has dropped below holdPct. Bounded per call.
 *
 * When `cfg.enabled` is false the threshold is ignored and held tasks are released
 * unconditionally — the operator turned the gate off, so nothing should remain blocked.
 *
 * When `cfg.autoRelease` is false (and the gate is still enabled) automatic release is
 * suppressed for usage holds: they stay queued until the operator starts or discards each one
 * manually from the held-tasks popover. Turning the gate off (`enabled: false`) overrides this
 * and still flushes everything.
 *
 * `after` holds (#2589) are a dependency, not that manual queue: each is skipped until its
 * predecessor's PR has landed, then released once usage is below holdPct — whatever
 * `autoRelease` says. `memory` holds likewise ignore `autoRelease`: the start gate decides.
 */
export async function releaseHeldTasks(
  deps: HeldReleaseDeps,
  cfg: { enabled: boolean; holdPct: number; autoRelease: boolean },
  now: number,
  maxPerTick = 3,
): Promise<{ released: number }> {
  const tasks = deps.store.listHeldTasks();
  let released = 0;

  for (const task of tasks) {
    if (released >= maxPerTick) break;
    // Waiting on a predecessor: skip, never block the tasks behind it.
    if (task.reason === "after" && !predecessorReady(deps, task.input.afterSessionId)) continue;
    if (!(await heldCapacityAvailable(deps, task, cfg, now))) continue;
    if (!(await startAdmitted(deps, task))) continue;
    try {
      const s = await deps.service.create(task.input);
      // service.create does not emit session:new — emit it so the released session
      // appears in the Herd live; the held:changed badge update follows below.
      deps.events.emit("session:new", s);
      deps.store.removeHeldTask(task.id);
      deps.store.markHeldDispatchStarted(task.id, s.id);
      released++;
      // A human linked an issue before the task was held: stamp the drain claim now that it's
      // spawning, matching handleSessionCreate/heldSpawn — so the board reflects it's being
      // worked and the drain won't double-spawn it. Deferred (macrotask) + best-effort:
      // addIssueLabel shells out synchronously, so setTimeout(0) keeps it off this sweep tick.
      const issueRef = task.input.issueRef;
      if (issueRef) {
        const { repoPath } = task.input;
        setTimeout(
          () => void claimLinkedIssue(deps.resolveForge?.(repoPath) ?? null, issueRef.number),
          0,
        );
      }
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
