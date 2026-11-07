/**
 * Operator CI restart hold (#2863). "Re-run" on an overdue job cancels the run, waits for it to
 * finish and re-runs it. In between, the PR rollup reads red (a cancelled job is a failure), and
 * both red-CI steer sources — autopilot's CI_FIX_STEER and the CI-finished steer (src/ci-steer.ts)
 * — would tell the agent to fix what was the operator's cancel. This holds them for the session.
 *
 * Phases: `cancelling` from the click, `rerun` once the re-run is issued. The hold lifts:
 *  - `running`: on the first `session:git` sample with checks in flight during `rerun` — the
 *    re-run is underway, so every later result is a fresh edge both consumers see normally;
 *  - `expired`: on the backstop timer (BACKSTOP_MS after `hold`, reset by `rerunIssued`);
 *  - `failed`: when the background restart fails.
 * Listeners learn the reason, so a red sample held back during the hold can be announced when the
 * restart did not supersede it.
 */
import type { EventHub } from "./events";
import type { GitState } from "./forge/types";
import { inFlight } from "./ci-steer";

export type CiRestartPhase = "cancelling" | "rerun";
export type CiRestartRelease = "running" | "expired" | "failed";

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
  #holds = new Map<string, { phase: CiRestartPhase; timer: unknown }>();
  #listeners: ((id: string, reason: CiRestartRelease) => void)[] = [];

  constructor(
    private readonly timers: Timers = REAL_TIMERS,
    private readonly backstopMs = BACKSTOP_MS,
  ) {}

  /** The operator clicked Re-run: hold red-CI steers while the run is cancelled. */
  hold(id: string): void {
    this.#arm(id, "cancelling");
  }

  /** The re-run was issued: lift on its first in-flight sample; the backstop restarts. */
  rerunIssued(id: string): void {
    if (this.#holds.has(id)) this.#arm(id, "rerun");
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

  /** Lift on the re-run's first in-flight sample; drop an archived session's hold silently. */
  attach(events: EventHub): void {
    events.subscribe((event, data) => {
      if (event === "session:git") {
        const { id, git } = data as { id: string; git: GitState };
        if (this.phase(id) === "rerun" && inFlight(git)) this.release(id, "running");
      } else if (event === "session:archived") {
        const id = (data as { id: string }).id;
        const h = this.#holds.get(id);
        if (h) this.timers.clear(h.timer);
        this.#holds.delete(id);
      }
    });
  }

  #arm(id: string, phase: CiRestartPhase): void {
    const prev = this.#holds.get(id);
    if (prev) this.timers.clear(prev.timer);
    const timer = this.timers.set(() => this.release(id, "expired"), this.backstopMs);
    this.#holds.set(id, { phase, timer });
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

/**
 * Cancel a stuck run, wait until GitHub reports it completed (a run in progress can't be re-run),
 * then re-run its failed and cancelled jobs. Runs in the background behind a 202; the hold is set
 * by the caller and lifted here on failure (on success it lifts on the re-run's in-flight sample).
 */
export async function restartCiRun(o: {
  id: string;
  runId: number;
  forge: CiRestartForge;
  holds: CiRestartHolds;
  refreshPr: (id: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  try {
    await o.forge.cancelWorkflowRun(o.runId);
    let completed = false;
    for (let waited = 0; waited < CANCEL_WAIT_MS && !completed; waited += POLL_MS) {
      await sleep(POLL_MS);
      completed = (await o.forge.getRunDetail(o.runId))?.status === "completed";
    }
    if (!completed) throw new Error(`run ${o.runId} still not completed after cancel`);
    await o.forge.rerunWorkflowRun(o.runId, { failedOnly: true });
    o.holds.rerunIssued(o.id);
    o.refreshPr(o.id);
  } catch (err) {
    console.warn(`[ci-restart] ${o.id} run ${o.runId}:`, err);
    o.holds.release(o.id, "failed");
    o.refreshPr(o.id);
  }
}
