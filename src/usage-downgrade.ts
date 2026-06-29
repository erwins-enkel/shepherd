/**
 * Pure downgrade-decision function for usage-aware model downgrading.
 *
 * The companion to usage-hold (`usage-hold.ts`): where hold *pauses* new spawns
 * once usage crosses `usageHoldPct`, downgrade keeps work flowing but on a cheaper
 * model once usage crosses the (lower) `usageDowngradePct`. The intended escalation
 * is two-tier — e.g. 80% → downgrade to a cheap model and keep going, 95% → hold.
 * The two thresholds are independent settings; if downgrade ≥ hold, hold simply
 * fires first (no spawn) and downgrade never gets a chance — a harmless no-op.
 *
 * Degraded-usage convention mirrors usage-hold: callers pass `0` for any window
 * when usage is unknown (uncalibrated caps, api-key mode → `limits()` returns null
 * windows). With 0, `Math.max(0, 0) >= downgradePct` is false, so we never downgrade
 * when usage can't be measured — the safe default (don't silently swap the operator's
 * chosen model on telemetry we don't have).
 */

export interface DowngradeDecisionInput {
  enabled: boolean; // config.usageDowngradeEnabled
  downgradePct: number; // config.usageDowngradePct (0..100)
  session5hPct: number; // 0 when usage unknown/uncalibrated
  weekPct: number; // 0 when usage unknown/uncalibrated
}

/** Returns true if new spawns should use the downgrade model instead of their configured one. */
export function shouldDowngrade(i: DowngradeDecisionInput): boolean {
  return i.enabled && Math.max(i.session5hPct, i.weekPct) >= i.downgradePct;
}
