import { expect, test } from "vitest";
import { planStallStatus, PLAN_FINAL_ROUND_TIMEOUT_MS } from "./plan-status";
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
