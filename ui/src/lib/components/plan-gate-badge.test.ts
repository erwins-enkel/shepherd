import { describe, it, expect } from "vitest";
import { canTriggerPlanReview } from "./plan-gate-badge";
import type { PlanGate, Session } from "$lib/types";

const baseGate: PlanGate = {
  sessionId: "s1",
  planHash: "hash",
  decision: "changes_requested",
  summary: "",
  body: "",
  findings: [],
  round: 3,
  cap: 3,
  approved: false,
  plan: "",
  updatedAt: 1_000_000,
};
const gate = (p: Partial<PlanGate>): PlanGate => ({ ...baseGate, ...p });
const session = (planPhase: Session["planPhase"]): Pick<Session, "planPhase"> => ({ planPhase });

describe("canTriggerPlanReview", () => {
  it("reviewing wins over an approved gate", () => {
    expect(canTriggerPlanReview(session("planning"), gate({ approved: true }), true)).toBe(
      "reviewing",
    );
  });
  it("an approved gate blocks when not reviewing", () => {
    expect(canTriggerPlanReview(session("planning"), gate({ approved: true }), false)).toBe(
      "approved",
    );
  });
  it("a startable gate (e.g. changes_requested at cap) is not blocked", () => {
    expect(
      canTriggerPlanReview(
        session("planning"),
        gate({ decision: "changes_requested", round: 3, cap: 3, approved: false }),
        false,
      ),
    ).toBeNull();
  });
  it("off the plan phase is never blocked, regardless of gate/reviewing", () => {
    expect(canTriggerPlanReview(session("executing"), gate({ approved: true }), true)).toBeNull();
  });
  it("no gate at all, not reviewing, is startable", () => {
    expect(canTriggerPlanReview(session("planning"), undefined, false)).toBeNull();
  });
});
