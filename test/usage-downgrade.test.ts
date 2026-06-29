import { expect, test } from "bun:test";
import { shouldDowngrade } from "../src/usage-downgrade";

const base = {
  enabled: true,
  downgradePct: 80,
  session5hPct: 0,
  weekPct: 0,
};

test("downgrades when usage high and enabled", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 85 })).toBe(true);
});

test("no downgrade when enabled=false (feature off)", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 85, enabled: false })).toBe(false);
});

test("no downgrade when below threshold (s5h=50, week=60)", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 50, weekPct: 60 })).toBe(false);
});

test("downgrades on weekly-only hot (max picks weekly)", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 10, weekPct: 85 })).toBe(true);
});

test("no downgrade when usage unknown (degraded: 0,0 → never downgrades)", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 0, weekPct: 0 })).toBe(false);
});

test("no downgrade at downgradePct=0 when usage unknown (0,0 stays the safe sentinel)", () => {
  expect(shouldDowngrade({ ...base, downgradePct: 0, session5hPct: 0, weekPct: 0 })).toBe(false);
});

test("downgrades at downgradePct=0 once any real usage is measured", () => {
  expect(shouldDowngrade({ ...base, downgradePct: 0, session5hPct: 1 })).toBe(true);
});

test("downgrades at boundary (s5h exactly at threshold)", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 80 })).toBe(true);
});

test("no downgrade just below boundary (79 < 80)", () => {
  expect(shouldDowngrade({ ...base, session5hPct: 79 })).toBe(false);
});
