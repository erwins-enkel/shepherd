import { describe, it, expect } from "vitest";
import { planGateChip, canRelease } from "./plan-gate-badge";
import type { PlanGate, Session } from "$lib/types";

const baseGate: PlanGate = {
  sessionId: "s1",
  planHash: "h",
  decision: "changes_requested",
  summary: "",
  body: "",
  findings: [],
  round: 1,
  cap: 3,
  approved: false,
  plan: "",
  updatedAt: 1_000_000,
};
const gate = (p: Partial<PlanGate>): PlanGate => ({ ...baseGate, ...p });
const sess = (planPhase: Session["planPhase"]): Pick<Session, "planPhase"> => ({ planPhase });

describe("planGateChip", () => {
  it("hides when planPhase is null", () => {
    expect(planGateChip(sess(null), undefined, false).kind).toBe("none");
  });

  it("hides when executing (gate already passed)", () => {
    expect(planGateChip(sess("executing"), gate({ approved: true }), false).kind).toBe("none");
  });

  it("reviewing wins over a stale verdict", () => {
    const chip = planGateChip(sess("planning"), gate({ approved: true }), true);
    expect(chip.kind).toBe("reviewing");
  });

  it("changes_requested surfaces the round/cap counter", () => {
    const chip = planGateChip(
      sess("planning"),
      gate({ decision: "changes_requested", round: 2, cap: 4 }),
      false,
    );
    expect(chip).toEqual({ kind: "changes", round: 2, cap: 4 });
  });

  it("approved + planning → ready", () => {
    const chip = planGateChip(
      sess("planning"),
      gate({ approved: true, decision: "approved" }),
      false,
    );
    expect(chip.kind).toBe("ready");
  });

  it("error verdict → error", () => {
    const chip = planGateChip(
      sess("planning"),
      gate({ decision: "error", approved: false }),
      false,
    );
    expect(chip.kind).toBe("error");
  });

  it("planning with no gate yet → planning", () => {
    expect(planGateChip(sess("planning"), undefined, false).kind).toBe("planning");
  });
});

describe("canRelease", () => {
  it("true only when approved and still planning", () => {
    expect(canRelease(sess("planning"), gate({ approved: true }))).toBe(true);
  });
  it("false when not approved", () => {
    expect(canRelease(sess("planning"), gate({ approved: false }))).toBe(false);
  });
  it("false when no gate", () => {
    expect(canRelease(sess("planning"), undefined)).toBe(false);
  });
  it("false once executing", () => {
    expect(canRelease(sess("executing"), gate({ approved: true }))).toBe(false);
  });
});
