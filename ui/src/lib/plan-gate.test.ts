import { describe, it, expect } from "vitest";
import { PlanGateStore } from "./reviews.svelte";
import type { PlanGate } from "./types";

const gate = (over: Partial<PlanGate> = {}): PlanGate => ({
  sessionId: "s1",
  planHash: "h",
  decision: "approved",
  summary: "",
  body: "",
  findings: [],
  round: 0,
  cap: 3,
  approved: true,
  plan: "P",
  updatedAt: 1,
  ...over,
});

describe("PlanGateStore", () => {
  it("ingests reviewing + verdict events; a verdict clears reviewing", () => {
    const s = new PlanGateStore();
    s.applyReviewing("s1", true);
    expect(s.isReviewing("s1")).toBe(true);
    s.apply("s1", gate());
    expect(s.map["s1"].approved).toBe(true);
    expect(s.isReviewing("s1")).toBe(false);
  });

  it("bootstraps from a snapshot + inflight list, seeding reviewer env", () => {
    const s = new PlanGateStore();
    s.bootstrap({ s1: gate({ decision: "changes_requested", approved: false, findings: ["x"] }) }, [
      { id: "s2", provider: "claude", model: "opus", effort: "high" },
    ]);
    expect(s.map["s1"].findings).toEqual(["x"]);
    expect(s.isReviewing("s2")).toBe(true);
    expect(s.reviewerEnvFor("s2")).toEqual({ provider: "claude", model: "opus", effort: "high" });
  });

  it("drop clears both the verdict and the reviewing flag", () => {
    const s = new PlanGateStore();
    s.apply("s1", gate());
    s.applyReviewing("s1", true);
    s.drop("s1");
    expect(s.map["s1"]).toBeUndefined();
    expect(s.isReviewing("s1")).toBe(false);
  });
});
