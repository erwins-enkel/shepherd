/**
 * Pure hold-decision function for usage-aware task holding (#825).
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
  activeSessionCount: number; // count of sessions with status === "running"
  force: boolean; // operator override
}

/** Returns true if the task should be held instead of spawned. */
export function shouldHold(i: HoldDecisionInput): boolean {
  return (
    i.enabled &&
    !i.force &&
    i.activeSessionCount >= 1 &&
    Math.max(i.session5hPct, i.weekPct) >= i.holdPct
  );
}
