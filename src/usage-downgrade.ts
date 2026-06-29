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
 * windows). A max usage of `0` is therefore the unknown sentinel, never a genuine
 * reading, so we never downgrade when usage can't be measured — even at
 * `downgradePct = 0` (which the UI allows). This is the safe default: don't silently
 * swap the operator's chosen model on telemetry we don't have.
 */

export interface DowngradeDecisionInput {
  enabled: boolean; // config.usageDowngradeEnabled
  downgradePct: number; // config.usageDowngradePct (0..100)
  session5hPct: number; // 0 when usage unknown/uncalibrated
  weekPct: number; // 0 when usage unknown/uncalibrated
}

/** Returns true if new spawns should use the downgrade model instead of their configured one. */
export function shouldDowngrade(i: DowngradeDecisionInput): boolean {
  const usage = Math.max(i.session5hPct, i.weekPct);
  // `usage === 0` is the unknown/uncalibrated sentinel (see module docstring): never
  // downgrade on telemetry we don't have, even when downgradePct is 0.
  return i.enabled && usage > 0 && usage >= i.downgradePct;
}
