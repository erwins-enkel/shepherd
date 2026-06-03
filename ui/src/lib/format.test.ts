import { describe, it, expect } from "vitest";
import { hideStatusBadge, relativeAge, formatAgo, heartbeatTone } from "./format";
import type { SessionStatus } from "./types";

describe("hideStatusBadge", () => {
  const cases: [SessionStatus, boolean, boolean][] = [
    // status, reviewing, hidden
    ["done", true, true],
    ["idle", true, true],
    ["done", false, false],
    ["idle", false, false],
    ["running", true, false],
    ["running", false, false],
    ["blocked", true, false],
    ["blocked", false, false],
    ["archived", true, false],
  ];

  for (const [status, reviewing, hidden] of cases) {
    it(`${status} + reviewing=${reviewing} → ${hidden ? "hidden" : "shown"}`, () =>
      expect(hideStatusBadge(status, reviewing)).toBe(hidden));
  }
});

describe("relativeAge", () => {
  const now = 1_000_000_000_000;
  it("formats compact units, floored", () => {
    expect(relativeAge(now, now)).toBe("now");
    expect(relativeAge(now - 30_000, now)).toBe("now"); // <60s
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2h");
    expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3d");
    expect(relativeAge(now + 10_000, now)).toBe("now"); // future clamps to 0
  });
});

describe("formatAgo", () => {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;
  const cases: [number, string][] = [
    [0, "0s"],
    [-5000, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59 * S, "59s"],
    [60 * S, "1m"],
    [59 * M + 59 * S, "59m"],
    [60 * M, "1h"],
    [23 * H + 59 * M, "23h"],
    [24 * H, "1d"],
    [3 * D + H, "3d"],
  ];
  for (const [ms, out] of cases) {
    it(`${ms}ms → ${out}`, () => expect(formatAgo(ms)).toBe(out));
  }
});

describe("heartbeatTone", () => {
  const cases: [number, ReturnType<typeof heartbeatTone>][] = [
    [0, "live"],
    [9_999, "live"],
    [10_000, "recent"],
    [59_999, "recent"],
    [60_000, "stale"],
    [120_000, "stale"],
  ];
  for (const [ms, out] of cases) {
    it(`${ms}ms → ${out}`, () => expect(heartbeatTone(ms)).toBe(out));
  }
});
