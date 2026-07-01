import { describe, it, expect } from "vitest";
import { steerAppliesToRepo } from "./steer-scope";
import type { Steer } from "./types";

function makeSteer(repos?: string[]): Steer {
  return {
    id: "s1",
    label: "test",
    text: "do it",
    inSteerBar: true,
    onIssues: false,
    ...(repos !== undefined ? { repos } : {}),
  };
}

describe("steerAppliesToRepo", () => {
  it("universal when repos is absent", () => {
    expect(steerAppliesToRepo(makeSteer(undefined), "alpha")).toBe(true);
    expect(steerAppliesToRepo(makeSteer(undefined), null)).toBe(true);
  });

  it("universal when repos is empty", () => {
    expect(steerAppliesToRepo(makeSteer([]), "alpha")).toBe(true);
    expect(steerAppliesToRepo(makeSteer([]), null)).toBe(true);
  });

  it("matches when repoName is in the allowlist", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha", "beta"]), "alpha")).toBe(true);
  });

  it("misses when repoName is not in the allowlist", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha", "beta"]), "gamma")).toBe(false);
  });

  it("hidden (not universal) when repoName is null and allowlist is non-empty", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha"]), null)).toBe(false);
  });
});
