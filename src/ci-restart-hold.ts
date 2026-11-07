/**
 * Operator CI restart hold (#2863). "Re-run" on an overdue job cancels the run, waits for it to
 * finish and re-runs it. In between, the PR rollup reads red (a cancelled job is a failure), and
 * both red-CI steer sources — autopilot's CI_FIX_STEER and the CI-finished steer (src/ci-steer.ts)
 * — would tell the agent to fix what was the operator's cancel. This holds them for the session.
 *
 * Phases: `cancelling` from the click, `rerun` once the re-run is issued. The hold lifts:
 *  - `running`: on the first `session:git` sample during `rerun` that shows the RESTARTED job
 *    pending on a new attempt (another workflow still running proves nothing: GitHub registers a
 *    re-run's check runs asynchronously, so the cancelled job can still read red) — the re-run is
 *    underway, so every later result is a fresh edge both consumers see normally;
 *  - `expired`: on the backstop timer (BACKSTOP_MS after `hold`, reset by `rerunIssued`);
 *  - `failed`: when the cancel itself fails (once it landed, a failed re-run holds to the backstop).
 * Listeners learn the reason, so a red sample held back during the hold can be announced when the
 * restart did not supersede it.
 */
import type { EventHub } from "./events";
import type { GitState } from "./forge/types";

export type CiRestartPhase = "cancelling" | "rerun";
export type CiRestartRelease = "running" | "expired" | "failed";

/** The job the operator restarted, as the PR cache showed it at the click. */
export interface RestartedJob {
  name: string;
  startedAt?: number;
}

/** The restarted job is running again on a new attempt: pending, and not the cancelled one (a
 *  re-run's job starts later; a still-queued one has no start yet). */
function rerunRunning(git: GitState, job: RestartedJob): boolean {
  const cur = (git.jobs ?? []).find((j) => j.name === job.name);
  return cur?.state === "pending" && cur.startedAt !== job.startedAt;
}

/** Long enough for the cancel wait plus one cold PR sweep after the re-run. */
const BACKSTOP_MS = 3 * 60_000;

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class CiRestartHolds {
  #holds = new Map<string, { phase: CiRestartPhase; job: RestartedJob; timer: unknown }>();
  #listeners: ((id: string, reason: CiRestartRelease) => void)[] = [];

  constructor(
    private readonly timers: Timers = REAL_TIMERS,
    private readonly backstopMs = BACKSTOP_MS,
  ) {}

  /** The operator clicked Re-run on `job`: hold red-CI steers while its run is cancelled. */
  hold(id: string, job: RestartedJob): void {
    this.#arm(id, "cancelling", job);
  }

  /** The re-run was issued: lift once the job runs again; the backstop restarts. */
  rerunIssued(id: string): void {
    const h = this.#holds.get(id);
    if (h) this.#arm(id, "rerun", h.job);
  }

  release(id: string, reason: CiRestartRelease): void {
    const h = this.#holds.get(id);
    if (!h) return;
    this.timers.clear(h.timer);
    this.#holds.delete(id);
    for (const cb of this.#listeners) cb(id, reason);
  }

  held(id: string): boolean {
    return this.#holds.has(id);
  }

  phase(id: string): CiRestartPhase | null {
    return this.#holds.get(id)?.phase ?? null;
  }

  onRelease(cb: (id: string, reason: CiRestartRelease) => void): void {
    this.#listeners.push(cb);
  }

  /** Lift once the restarted job runs again; drop an archived session's hold silently. */
  attach(events: EventHub): void {
    events.subscribe((event, data) => {
      if (event === "session:git") {
        const { id, git } = data as { id: string; git: GitState };
        const h = this.#holds.get(id);
        if (h?.phase === "rerun" && rerunRunning(git, h.job)) this.release(id, "running");
      } else if (event === "session:archived") {
        const id = (data as { id: string }).id;
        const h = this.#holds.get(id);
        if (h) this.timers.clear(h.timer);
        this.#holds.delete(id);
      }
    });
  }

  #arm(id: string, phase: CiRestartPhase, job: RestartedJob): void {
    const prev = this.#holds.get(id);
    if (prev) this.timers.clear(prev.timer);
    const timer = this.timers.set(() => this.release(id, "expired"), this.backstopMs);
    this.#holds.set(id, { phase, job, timer });
  }
}

/** The run id in a GitHub Actions job URL (`…/actions/runs/<id>/job/<job>`); null otherwise. */
export function runIdFromJobUrl(url: string | undefined): number | null {
  const m = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(url ?? "");
  return m ? Number(m[1]) : null;
}

/** What a CI restart needs from the forge (GitHub implements all three). */
export interface CiRestartForge {
  cancelWorkflowRun(runId: number): Promise<void>;
  getRunDetail(runId: number): Promise<{ status: string } | null>;
  rerunWorkflowRun(runId: number, o: { failedOnly: boolean }): Promise<void>;
}

const POLL_MS = 3_000;
const CANCEL_WAIT_MS = 90_000;

/** Where a background restart failed: the cancel itself (the run is untouched, so its red is
 *  real), or after the cancel landed (the run is cancelled but not re-run). */
export type CiRestartFailure = "cancel" | "rerun";

/**
 * Cancel a stuck run, wait until GitHub reports it completed (a run in progress can't be re-run),
 * then re-run its failed and cancelled jobs. Runs in the background behind a 202, so a failure is
 * reported through `onFailed` for the operator. The hold is set by the caller; on success it lifts
 * once the job runs again. A failed cancel releases it (`failed`): nothing was cancelled. Once the
 * cancel landed the red is the operator's, so a failed wait or re-run keeps holding until the
 * backstop — time for the operator, told by `onFailed`, to re-run it themselves.
 */
export async function restartCiRun(o: {
  id: string;
  runId: number;
  forge: CiRestartForge;
  holds: CiRestartHolds;
  refreshPr: (id: string) => void;
  onFailed: (reason: CiRestartFailure) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  try {
    await o.forge.cancelWorkflowRun(o.runId);
  } catch (err) {
    console.warn(`[ci-restart] ${o.id} cancel run ${o.runId}:`, err);
    o.holds.release(o.id, "failed");
    o.onFailed("cancel");
    return;
  }
  try {
    let completed = false;
    for (let waited = 0; waited < CANCEL_WAIT_MS && !completed; waited += POLL_MS) {
      await sleep(POLL_MS);
      completed = (await o.forge.getRunDetail(o.runId))?.status === "completed";
    }
    if (!completed) throw new Error(`run ${o.runId} still not completed after cancel`);
    await o.forge.rerunWorkflowRun(o.runId, { failedOnly: true });
    o.holds.rerunIssued(o.id);
  } catch (err) {
    console.warn(`[ci-restart] ${o.id} re-run run ${o.runId}:`, err);
    o.onFailed("rerun");
  }
  o.refreshPr(o.id);
}
