import { expect, test } from "bun:test";
import { matchesUsageLimit } from "../src/usage-halt";

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
