import { expect, test } from "bun:test";
import { matchesUsageLimit, classifyHalt } from "../src/usage-halt";
import type { UsageLimits } from "../src/usage-limits";

// NOTE: All positive test strings below are SYNTHETIC — no real captured usage-limit
// output from Claude Code was available at authoring time. Real-sample calibration is
// a follow-up task once live samples are captured.

test("matches Claude usage limit reached", () => {
  expect(matchesUsageLimit("Claude usage limit reached. Your limit will reset at 3:00pm.")).toBe(
    true,
  );
});

test("matches 5-hour limit with hyphen", () => {
  expect(matchesUsageLimit("You've hit the 5-hour limit — resets at 9:30pm")).toBe(true);
});

test("matches 5 hour limit without hyphen", () => {
  expect(matchesUsageLimit("You have reached the 5 hour limit for this period.")).toBe(true);
});

test("matches weekly limit with resets mention", () => {
  expect(matchesUsageLimit("Weekly limit reached. Resets Monday.")).toBe(true);
});

test("matches limit reached + reset at", () => {
  expect(matchesUsageLimit("limit reached. Your usage will reset at midnight.")).toBe(true);
});

test("matches limit reached + resets", () => {
  expect(matchesUsageLimit("Usage limit reached — resets in 2 hours.")).toBe(true);
});

test("no false positive: normal completion", () => {
  expect(matchesUsageLimit("I've finished the task and committed the changes.")).toBe(false);
});

test("no false positive: empty string", () => {
  expect(matchesUsageLimit("")).toBe(false);
});

test("no false positive: benign rate limit mention", () => {
  expect(matchesUsageLimit("Consider adding a rate limit to your API.")).toBe(false);
});

test("no false positive: partial keyword without context", () => {
  expect(matchesUsageLimit("You should limit your requests per second.")).toBe(false);
});

// ── classifyHalt ──────────────────────────────────────────────────────────────

const MATCH = "Claude usage limit reached. Your limit will reset at 3:00pm.";
const NO_MATCH = "I finished the task.";

function limits(session5hPct: number | null, weekPct: number | null): UsageLimits {
  return {
    session5h: session5hPct !== null ? { pct: session5hPct, resetAt: 0 } : null,
    week: weekPct !== null ? { pct: weekPct, resetAt: 0 } : null,
    credits: null,
    stale: false,
    calibratedAt: Date.now(),
    subscriptionOnly: false,
  };
}

test("classifyHalt: match + session5h=95 above holdPct=80 → usage_limit", () => {
  expect(classifyHalt(MATCH, limits(95, null), 80)).toBe("usage_limit");
});

test("classifyHalt: match + both windows null (uncalibrated) → usage_limit (degraded)", () => {
  expect(classifyHalt(MATCH, limits(null, null), 80)).toBe("usage_limit");
});

test("classifyHalt: match + session5h=40, week null, holdPct=80 → null (measurable below cap)", () => {
  expect(classifyHalt(MATCH, limits(40, null), 80)).toBeNull();
});

test("classifyHalt: no match + high usage → null", () => {
  expect(classifyHalt(NO_MATCH, limits(99, 99), 80)).toBeNull();
});

test("classifyHalt: match + week=90 above holdPct=80 → usage_limit", () => {
  expect(classifyHalt(MATCH, limits(null, 90), 80)).toBe("usage_limit");
});

test("classifyHalt: match + both windows at exactly holdPct → usage_limit (>= is inclusive)", () => {
  expect(classifyHalt(MATCH, limits(80, null), 80)).toBe("usage_limit");
});

test("classifyHalt: match + both windows just below holdPct → null", () => {
  expect(classifyHalt(MATCH, limits(79, 79), 80)).toBeNull();
});
