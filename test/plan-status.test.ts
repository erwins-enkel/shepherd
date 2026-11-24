import { readFileSync } from "node:fs";
import { describe, it, expect } from "bun:test";
import {
  planStallStatus,
  PLAN_FINAL_ROUND_TIMEOUT_MS,
  type PlanStallStatus,
} from "../src/plan-status";
import type { PlanGate } from "../src/types";

/** Minimal PlanGate fixture; only the fields planStallStatus inspects. */
function makeGate(overrides: Partial<PlanGate> = {}): PlanGate {
  return {
    sessionId: "s1",
    planHash: "h1",
    decision: "changes_requested",
    summary: "test",
    body: "body",
    findings: ["finding 1"],
    round: 1,
    cap: 5,
    approved: false,
    plan: "plan text",
    updatedAt: Date.now(),
    ...overrides,
  };
}

const NOW = 1_000_000_000_000;

describe("planStallStatus", () => {
  it('returns "round" when round < cap', () => {
    expect(planStallStatus(makeGate({ round: 2, cap: 5, updatedAt: NOW }), NOW)).toBe("round");
  });

  it('returns "final" on the just-landed final round (round==cap, finalRoundPending, recent)', () => {
    const g = makeGate({ round: 5, cap: 5, finalRoundPending: true, updatedAt: NOW - 60_000 });
    expect(planStallStatus(g, NOW)).toBe("final");
  });

  it('returns "stalled" at cap with finalRoundPending=false (post-cap re-review / takeover)', () => {
    const g = makeGate({ round: 5, cap: 5, finalRoundPending: false, updatedAt: NOW });
    expect(planStallStatus(g, NOW)).toBe("stalled");
  });

  it('returns "stalled" when the pending final round has timed out', () => {
    const g = makeGate({
      round: 5,
      cap: 5,
      finalRoundPending: true,
      updatedAt: NOW - PLAN_FINAL_ROUND_TIMEOUT_MS - 1,
    });
    expect(planStallStatus(g, NOW)).toBe("stalled");
  });

  it("treats round over cap like at cap", () => {
    expect(planStallStatus(makeGate({ round: 9, cap: 5, updatedAt: NOW }), NOW)).toBe("stalled");
  });
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

describe("planStallStatus (server) — shared parity fixture (server ↔ UI drift lock)", () => {
  // The SAME fixture is asserted by ui/src/lib/plan-status.test.ts against the mirrored UI
  // copy; drift between the two implementations fails one suite.
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/plan-status-parity.json", import.meta.url), "utf8"),
  ) as ParityFixture;
  it("PLAN_FINAL_ROUND_TIMEOUT_MS matches the fixture", () => {
    expect(PLAN_FINAL_ROUND_TIMEOUT_MS).toBe(fixture.timeoutMs);
  });
  for (const { name, ageMs, expected, ...fields } of fixture.cases) {
    it(name, () => {
      expect(planStallStatus(makeGate({ ...fields, updatedAt: NOW - ageMs }), NOW)).toBe(expected);
    });
  }
});
