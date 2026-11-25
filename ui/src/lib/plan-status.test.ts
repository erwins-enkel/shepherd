import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { planStallStatus, PLAN_FINAL_ROUND_TIMEOUT_MS, type PlanStallStatus } from "./plan-status";
import type { PlanGate } from "./types";

const NOW = 1_000_000_000_000;

function gate(over: Partial<PlanGate> = {}): PlanGate {
  return {
    sessionId: "s1",
    planHash: "h1",
    decision: "changes_requested",
    summary: "",
    body: "",
    findings: ["f"],
    round: 1,
    cap: 5,
    approved: false,
    plan: "",
    updatedAt: NOW,
    ...over,
  };
}

test('planStallStatus "round" below cap', () => {
  expect(planStallStatus(gate({ round: 2, cap: 5 }), NOW)).toBe("round");
});

test('planStallStatus "final" on the just-landed final round', () => {
  expect(
    planStallStatus(
      gate({ round: 5, cap: 5, finalRoundPending: true, updatedAt: NOW - 1000 }),
      NOW,
    ),
  ).toBe("final");
});

test('planStallStatus "stalled" at cap without a pending final round', () => {
  expect(planStallStatus(gate({ round: 5, cap: 5, finalRoundPending: false }), NOW)).toBe(
    "stalled",
  );
});

test('planStallStatus "stalled" once the pending final round times out', () => {
  expect(
    planStallStatus(
      gate({
        round: 5,
        cap: 5,
        finalRoundPending: true,
        updatedAt: NOW - PLAN_FINAL_ROUND_TIMEOUT_MS - 1,
      }),
      NOW,
    ),
  ).toBe("stalled");
});

type ParityFixture = {
  timeoutMs: number;
  cases: {
    name: string;
    round: number;
    cap: number;
    finalRoundPending: boolean;
    ageMs: number;
    expected: PlanStallStatus;
  }[];
};

describe("planStallStatus (UI) — shared parity fixture (server ↔ UI drift lock)", () => {
  // The SAME fixture is asserted by test/plan-status.test.ts against the server copy; drift
  // between the two implementations fails one suite.
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/plan-status-parity.json", import.meta.url),
      "utf8",
    ),
  ) as ParityFixture;
  test("PLAN_FINAL_ROUND_TIMEOUT_MS matches the fixture", () => {
    expect(PLAN_FINAL_ROUND_TIMEOUT_MS).toBe(fixture.timeoutMs);
  });
  for (const { name, ageMs, expected, ...fields } of fixture.cases) {
    test(name, () => {
      expect(planStallStatus(gate({ ...fields, updatedAt: NOW - ageMs }), NOW)).toBe(expected);
    });
  }
});
