import { describe, it, expect } from "vitest";
import { controlKeys } from "./controlKeys";

// Guard the byte sequences against silent drift — these are the actual control
// codes a real terminal sends; a wrong byte steers the agent wrong.
const EXPECTED: Record<string, string> = {
  Esc: "\x1b",
  Tab: "\x09",
  "⏎": "\x0d",
  "←": "\x1b[D",
  "→": "\x1b[C",
  "↑": "\x1b[A",
  "↓": "\x1b[B",
  "^A": "\x01",
  "^E": "\x05",
  "^C": "\x03",
  "^D": "\x04",
};

describe("controlKeys", () => {
  it("maps every label to the exact control sequence", () => {
    const got = Object.fromEntries(controlKeys().map((k) => [k.label, k.seq]));
    expect(got).toEqual(EXPECTED);
  });

  it("has a non-empty accessible name for every key", () => {
    for (const k of controlKeys()) {
      expect(k.aria.trim().length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate labels", () => {
    const labels = controlKeys().map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
