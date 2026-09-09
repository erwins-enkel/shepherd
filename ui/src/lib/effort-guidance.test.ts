import { describe, expect, it } from "vitest";
import {
  effortAvailableForProvider,
  effortBelowHigh,
  effortLabel,
  providerEfforts,
} from "./effort-guidance";

describe("provider effort availability", () => {
  it.each([
    ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4", ["low", "medium", "high", "xhigh"]],
    ["default", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["future-model", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ] as const)("offers the supported tiers for %s", (model, tiers) => {
    expect(providerEfforts("codex", model)).toEqual(tiers);
  });
  it("offers only Claude's CLI tiers", () => {
    expect(providerEfforts("claude", "opus")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortAvailableForProvider("claude", "ultra", "opus")).toBe(false);
  });
  it("validates a choice against its model and keeps default available", () => {
    expect(effortAvailableForProvider("codex", "ultra", "gpt-6-astra")).toBe(true);
    expect(effortAvailableForProvider("codex", "ultra", "gpt-5.6-luna")).toBe(false);
    expect(effortAvailableForProvider("codex", "max", "gpt-5.6-luna")).toBe(true);
    expect(effortAvailableForProvider("codex", "default", "gpt-5.5")).toBe(true);
    expect(effortLabel("ultra")).toBe("Ultra");
  });
});

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
