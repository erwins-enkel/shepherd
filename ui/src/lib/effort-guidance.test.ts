import { describe, expect, it } from "vitest";
import { effortBelowHigh } from "./effort-guidance";

// Mirrors test/default-effort.test.ts (the canonical server helper). The critic guardrail (#1430)
// treats any setting resolving below `high` — low, medium, AND "default" — as weakening PR review.
describe("effortBelowHigh (critic guardrail — UI mirror)", () => {
  it("treats low and medium as below high", () => {
    expect(effortBelowHigh("low")).toBe(true);
    expect(effortBelowHigh("medium")).toBe(true);
  });

  it("treats 'default' as below high (no --effort flag → CLI's below-high native default)", () => {
    expect(effortBelowHigh("default")).toBe(true);
  });

  it("treats high, xhigh and max as safe (not below high)", () => {
    expect(effortBelowHigh("high")).toBe(false);
    expect(effortBelowHigh("xhigh")).toBe(false);
    expect(effortBelowHigh("max")).toBe(false);
  });

  it("treats unknown/junk strings as not below high", () => {
    for (const v of ["inherit", "minimal", "", "gpt4"]) expect(effortBelowHigh(v)).toBe(false);
  });
});
