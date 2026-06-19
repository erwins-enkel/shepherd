// NOTE: Positive patterns below are derived from documented/known Claude Code phrasings.
// No real captured usage-limit output was available at authoring time.
// Real-sample calibration is a follow-up once live samples are captured.

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
