import { test, expect } from "vitest";
import { formatTokens, formatReset } from "../src/lib/format";

test("formatTokens compacts to k/M", () => {
  expect(formatTokens(0)).toBe("0");
  expect(formatTokens(999)).toBe("999");
  expect(formatTokens(1500)).toBe("1.5k");
  expect(formatTokens(12_000)).toBe("12k");
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(formatTokens(12_000_000)).toBe("12M");
});

test("formatReset: time-of-day when same day, date otherwise", () => {
  const now = new Date("2026-05-30T10:00:00").getTime();
  const sameDay = new Date("2026-05-30T21:30:00").getTime();
  expect(formatReset(sameDay, now)).toBe("21:30");
  expect(formatReset(sameDay, now, { withTime: true })).toBe("21:30");
  const otherDay = new Date("2026-06-06T17:00:00").getTime();
  expect(formatReset(otherDay, now)).toMatch(/Jun/);
  expect(formatReset(otherDay, now, { withTime: true })).toBe("6.6. 17:00");
});
