import { describe, it, expect } from "vitest";
import { hideStatusBadge, relativeAge } from "./format";
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
