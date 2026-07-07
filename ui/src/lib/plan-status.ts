/**
 * Shared plan-gate rework-status predicate.
 * Mirror pair: src/plan-status.ts — keep both files byte-identical in logic.
 *
 * The structural twin of addressStallStatus (ui/src/lib/review-status.ts) for the pre-execution
 * plan gate. The plan gate has no per-row finalRoundTimeoutMs column, so the timeout is this shared
 * constant (matching the reviews table's 900_000 ms default).
 */
import type { PlanGate } from "./types";

export type PlanStallStatus = "round" | "final" | "stalled";

/** Abandonment window for a plan gate's final rework round (ms). Mirror-pinned constant. */
export const PLAN_FINAL_ROUND_TIMEOUT_MS = 900_000;

/**
 * Pure tri-state decision for a plan-rework streak's current status.
 *  - "round":   below the cap — the auto-loop is still steering findings back.
 *  - "final":   at/over the cap, finalRoundPending=true, and not yet timed out — the final steer
 *               landed and the agent is actively revising the plan.
 *  - "stalled": at/over the cap with no pending final round (post-cap re-review / takeover), or the
 *               pending final round has timed out.
 *
 * `now` is a ms timestamp (Date.now() or a reactive clock).
 */
export function planStallStatus(g: PlanGate, now: number): PlanStallStatus {
  const cap = g.cap;
  const round = Math.min(g.round, cap);
  if (round < cap) return "round";
  if (!g.finalRoundPending) return "stalled";
  if (now - g.updatedAt > PLAN_FINAL_ROUND_TIMEOUT_MS) return "stalled";
  return "final";
}
