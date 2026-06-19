// NOTE: Positive patterns below are derived from documented/known Claude Code phrasings.
// No real captured usage-limit output was available at authoring time.
// Real-sample calibration is a follow-up once live samples are captured.

import type { UsageLimits } from "./usage-limits";

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  // "claude usage limit" phrase
  /claude\s+usage\s+limit/i,
  // "usage limit reached"
  /usage\s+limit\s+reached/i,
  // "5-hour limit" or "5 hour limit"
  /5[- ]hour\s+limit/i,
  // "weekly limit"
  /weekly\s+limit/i,
  // "limit reached" combined with a reset mention (resets / reset at)
  /limit\s+reached[\s\S]{0,120}reset/i,
];

/**
 * Returns true when the given tail text matches Claude Code's usage-limit wording.
 *
 * Centralized here so wording drift is tuned in one place.
 * Patterns are intentionally specific to avoid false positives on benign text
 * such as "rate limit your requests" or "limit the number of connections".
 */
export function matchesUsageLimit(tail: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(tail));
}

/**
 * Pure halt classifier — unit-testable without the poller.
 *
 * Returns "usage_limit" when the tail matches AND usage corroborates (or usage
 * is unknown/uncalibrated). Returns null otherwise.
 *
 * Corroboration rule:
 *  - If the tail does not match → null (fast exit).
 *  - If usage is known (at least one window non-null) AND the highest window pct
 *    is below `holdPct` → null (measurable but not near cap; probably not a
 *    real halt).
 *  - Otherwise (usage unknown OR at/above cap) → "usage_limit" (degrade
 *    gracefully when telemetry is unavailable so real halts are never silently
 *    dropped).
 */
export function classifyHalt(
  tail: string,
  limits: UsageLimits,
  holdPct: number,
): "usage_limit" | null {
  if (!matchesUsageLimit(tail)) return null;
  const s5h = limits.session5h;
  const wk = limits.week;
  const usageKnown = s5h !== null || wk !== null;
  const nearCap = Math.max(s5h?.pct ?? 0, wk?.pct ?? 0) >= holdPct;
  return !usageKnown || nearCap ? "usage_limit" : null;
}
