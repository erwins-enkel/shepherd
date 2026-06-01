import { describe, it, expect } from "vitest";
import { hideStatusBadge } from "./format";
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
