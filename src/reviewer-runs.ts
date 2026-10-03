import { reapRun } from "./critic-core";
import type { ReviewerEnv } from "./types";

/** The slice of an in-flight reviewer run the operator's hold/cancel controls touch. */
export interface ReviewerRun {
  sessionId: string;
  terminalId: string;
  worktreePath: string;
  reviewerProvider: ReviewerEnv["provider"];
  reviewerModel: string | null;
  reviewerEffort: string | null;
  startedAt: number;
  finalizing?: boolean;
  /** Operator hold (the review banner's "Anhalten"): set while held, to the ms it started. tick()
   *  leaves a held run unsettled — nothing is persisted or pasted — until release. In-memory only. */
  heldSince?: number | null;
}

/**
 * The in-flight run registry shared by the PR critic (ReviewService) and the plan gate
 * (PlanGateService): the `inflight` / `starting` claims plus the operator controls on top of them —
 * the `…/inflight` bootstrap rows, hold / release, and cancel. Each service supplies its own
 * teardown bookkeeping through the abstract hooks.
 */
export abstract class ReviewerRuns<F extends ReviewerRun> {
  protected inflight = new Map<string, F>();
  // Session ids whose reviewer is mid-spawn but not yet in `inflight` (see each service's begin()).
  protected starting = new Set<string>();

  protected abstract runDeps(): {
    herdr: { stop(terminalId: string): Promise<void> };
    worktree: { remove(worktreePath: string): void };
    onReviewing?: (id: string, reviewing: boolean, env?: ReviewerEnv) => void;
    onHeld?: (id: string, held: boolean) => void;
  };
  protected abstract nowMs(): number;
  /** Drop an in-flight run AND release its per-spawn resources (see each service). */
  protected abstract dropInflight(sessionId: string, f: F): void;
  /** Book the run's token usage on its reviewer_spawns row. Never throws. */
  protected abstract captureRunUsage(f: F): Promise<void>;
  /** Remember what the cancelled run reviewed so the auto path doesn't re-run it unchanged. */
  protected abstract markCancelled(f: F): void;

  /** The run's hard deadline, surfaced on the `…/inflight` rows; undefined when not exposed. */
  protected runTimeoutMs(): number | undefined {
    return undefined;
  }

  /** The reviewer environment a run reports to clients: who reviews, plus its clock. */
  protected runEnv(f: F): ReviewerEnv {
    const timeoutMs = this.runTimeoutMs();
    return {
      provider: f.reviewerProvider,
      model: f.reviewerModel,
      effort: f.reviewerEffort,
      startedAt: f.startedAt,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  }

  /** In-flight reviews with the exact reviewer environment captured for each spawn. */
  reviewingInflight(): Array<{ id: string; held: boolean } & ReviewerEnv> {
    return [...this.inflight.values()].map((f) => ({
      id: f.sessionId,
      ...this.runEnv(f),
      held: f.heldSince != null,
    }));
  }

  /** Worktree paths of runs currently owned in-memory — the GC sweep must spare these (a
   *  re-adopted #631 orphan's tick() still needs its worktree). */
  inflightWorktrees(): string[] {
    return [...this.inflight.values()].map((f) => f.worktreePath);
  }

  /** Operator hold / release of the in-flight run. While held, tick() neither settles nor pastes;
   *  the reviewer itself keeps running. Held time doesn't count toward the timeout (startedAt
   *  shifts forward on release). False when nothing is in flight. */
  setHeld(sessionId: string, held: boolean): boolean {
    const f = this.inflight.get(sessionId);
    if (!f) return false;
    if (held === (f.heldSince != null)) return true;
    const now = this.nowMs();
    if (held) f.heldSince = now;
    else {
      f.startedAt += now - f.heldSince!;
      f.heldSince = null;
    }
    const deps = this.runDeps();
    deps.onHeld?.(sessionId, held);
    // Release moved startedAt; re-send the env so a client's run clock excludes the held time.
    if (!held) deps.onReviewing?.(sessionId, true, this.runEnv(f));
    return true;
  }

  /** Operator cancel of the in-flight run: reap it WITHOUT settling — no verdict, no paste, no
   *  round — and suppress an automatic re-run of the same input. "skipped" while mid-spawn or
   *  claimed by a real finalize; "none" when nothing is in flight. */
  async cancel(sessionId: string): Promise<"cancelled" | "skipped" | "none"> {
    const f = await claimForCancel(this.inflight, sessionId);
    if (!f)
      return this.starting.has(sessionId) || this.inflight.has(sessionId) ? "skipped" : "none";
    // Still synchronous with the claim, so an overlapping tick() can't reach the run.
    this.dropInflight(sessionId, f);
    this.markCancelled(f);
    const deps = this.runDeps();
    deps.onReviewing?.(sessionId, false);
    await this.captureRunUsage(f);
    await reapRun(deps.herdr, deps.worktree, f.terminalId, f.worktreePath);
    return "cancelled";
  }
}

/** Claim an in-flight run for an operator cancel. The critic's tick() holds `finalizing` across
 *  its liveness awaits even when it then decides to keep waiting, so a cancel landing in that window
 *  polls briefly for the claim to release instead of failing. Returns the entry with `finalizing`
 *  set (synchronously after the last check, so an overlapping tick skips it), or null when the run
 *  is gone, was replaced, or stayed claimed by a real finalize. */
async function claimForCancel<F extends { finalizing?: boolean }>(
  inflight: Map<string, F>,
  id: string,
  opts: { attempts: number; intervalMs: number } = { attempts: 30, intervalMs: 100 },
): Promise<F | null> {
  const run = inflight.get(id);
  for (let i = 0; ; i++) {
    const f = inflight.get(id);
    if (!f || f !== run) return null; // gone, or a NEW run took the slot while we waited
    if (!f.finalizing) {
      f.finalizing = true;
      return f;
    }
    if (i >= opts.attempts) return null;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}
