import { describe, it, expect } from "vitest";
import { holdAwaitsOperator } from "./hold";
import type { HoldCode } from "./types";

// The INTENDED classification, declared independently of hold.ts's HOLD_AWAITS_OPERATOR
// map so a divergent edit there is caught. Typed as Record<HoldCode, boolean> so a newly
// added HoldCode fails to compile here until its expected value is stated — the test's
// exhaustiveness guard mirrors the map's.
const EXPECTED: Record<HoldCode, boolean> = {
  // The agent has stopped and awaits a DIRECT operator action → wash.
  "halted-error": true,
  "autopilot-paused": true,
  "blocked-menu": true,
  "blocked-yes-no": true,
  "blocked-awaiting-input": true,
  "blocked-generic": true,
  "plan-rework": true,
  "plan-question": true,
  "manual-steps": true,
  // Failure / advisory / autonomous / auto-resuming / handed-off / green-complete → no wash.
  "blocked-stall": false,
  "quota-rework": false,
  "quota-review": false,
  "quota-error": false,
  "quota-plan": false,
  "critic-rework": false,
  "ci-red": false,
  "pr-conflict": false,
  "awaiting-merge": false,
  "train-error": false,
  stalled: false,
  "recap-attention": false,
  merging: false,
  "merge-rebasing": false,
  "ready-merge": false,
  "halted-usage": false,
};

describe("holdAwaitsOperator", () => {
  for (const [code, expected] of Object.entries(EXPECTED) as [HoldCode, boolean][]) {
    it(`${code} → ${expected}`, () => {
      expect(holdAwaitsOperator({ code })).toBe(expected);
    });
  }

  it("washes exactly the nine agent-awaits-operator holds", () => {
    const wash = Object.entries(EXPECTED)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
    expect(wash).toEqual(
      [
        "autopilot-paused",
        "blocked-awaiting-input",
        "blocked-generic",
        "blocked-menu",
        "blocked-yes-no",
        "halted-error",
        "manual-steps",
        "plan-question",
        "plan-rework",
      ].sort(),
    );
  });

  it("never washes a failure / non-agent state (no-failure-wash rule)", () => {
    for (const code of ["ci-red", "train-error", "halted-usage"] as HoldCode[]) {
      expect(holdAwaitsOperator({ code })).toBe(false);
    }
  });
});
