import { describe, it, expect } from "vitest";
import { CONTROL_KEYS } from "./controlKeys";

// Guard the byte sequences against silent drift — these are the actual control
// codes a real terminal sends; a wrong byte steers the agent wrong.
const EXPECTED: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\x09",
  "←": "\x1b[D",
  "→": "\x1b[C",
  "↑": "\x1b[A",
  "↓": "\x1b[B",
  "^A": "\x01",
  "^E": "\x05",
  "^C": "\x03",
  "^D": "\x04",
};

describe("CONTROL_KEYS", () => {
  it("maps every label to the exact control sequence", () => {
    const got = Object.fromEntries(CONTROL_KEYS.map((k) => [k.label, k.seq]));
    expect(got).toEqual(EXPECTED);
  });

  it("has a non-empty accessible name for every key", () => {
    for (const k of CONTROL_KEYS) {
      expect(k.aria.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate labels", () => {
    const labels = CONTROL_KEYS.map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
