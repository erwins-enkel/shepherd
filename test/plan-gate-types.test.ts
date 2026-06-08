import { expect, test } from "bun:test";
import type { PlanGate, Session } from "../src/types";
test("PlanGate + Session plan fields are shaped", () => {
  const g: PlanGate = {
    sessionId: "s",
    planHash: "h",
    decision: "approved",
    summary: "",
    body: "",
    findings: [],
    round: 0,
    cap: 3,
    approved: true,
    plan: "p",
    updatedAt: 1,
  };
  const phase: Session["planPhase"] = "planning";
  expect(g.approved).toBe(true);
  expect(phase).toBe("planning");
});
