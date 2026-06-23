/**
 * Pure hold-decision function for usage-aware task holding (#825).
 *
 * Deliberate deviation from #825's literal trigger: that issue specified a
 * three-part AND including "≥1 session is already running" (so an idle herd was
 * let through). We dropped that carve-out — it assumed headroom and misfired at
 * the cap (a task spawned at 100% halts instantly into a useless husk). Hold now
 * gates on usage alone, matching the release sweeper (`held-release.ts`, releases
 * on `max(5h,week) < holdPct` with no running-count term) and auto-drain
 * (`drain-core.ts`, holds on `usagePct >= ceiling`). Hold/release/drain are now
 * symmetric on one rule.
 *
 * Degraded-usage convention: callers pass `0` for any window when usage is
 * unknown (uncalibrated caps, api-key mode → `limits()` returns null windows).
 * With 0, `Math.max(0, 0) >= holdPct` is always false, so we never hold when
 * usage can't be measured — the safe default (don't freeze manual work we
 * can't measure). No special-casing needed here; the `0` convention handles it.
 */

export interface HoldDecisionInput {
  enabled: boolean; // config.usageHoldEnabled
  holdPct: number; // config.usageHoldPct (0..100)
  session5hPct: number; // 0 when usage unknown/uncalibrated
  weekPct: number; // 0 when usage unknown/uncalibrated
  force: boolean; // operator override
}

/** Returns true if the task should be held instead of spawned. */
export function shouldHold(i: HoldDecisionInput): boolean {
  return i.enabled && !i.force && Math.max(i.session5hPct, i.weekPct) >= i.holdPct;
}
