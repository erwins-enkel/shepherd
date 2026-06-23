import { expect, test } from "bun:test";
import { shouldHold } from "../src/usage-hold";

const base = {
  enabled: true,
  holdPct: 80,
  session5hPct: 0,
  weekPct: 0,
  force: false,
};

test("holds when usage high, enabled, not forced", () => {
  expect(shouldHold({ ...base, session5hPct: 85 })).toBe(true);
});

test("holds when usage high even with an idle herd (no running-session term)", () => {
  expect(shouldHold({ ...base, session5hPct: 85 })).toBe(true);
});

test("no hold when force=true (operator override)", () => {
  expect(shouldHold({ ...base, session5hPct: 85, force: true })).toBe(false);
});

test("no hold when enabled=false (feature off)", () => {
  expect(shouldHold({ ...base, session5hPct: 85, enabled: false })).toBe(false);
});

test("no hold when below threshold (s5h=50, week=60)", () => {
  expect(shouldHold({ ...base, session5hPct: 50, weekPct: 60 })).toBe(false);
});

test("holds on weekly-only hot (max picks weekly)", () => {
  expect(shouldHold({ ...base, session5hPct: 10, weekPct: 85 })).toBe(true);
});

test("no hold when usage unknown (degraded: 0,0 → never holds)", () => {
  expect(shouldHold({ ...base, session5hPct: 0, weekPct: 0 })).toBe(false);
});

test("holds at boundary (s5h exactly at threshold)", () => {
  expect(shouldHold({ ...base, session5hPct: 80 })).toBe(true);
});
