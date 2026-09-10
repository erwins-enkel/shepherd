import { describe, expect, it } from "bun:test";
import { abandonRemaining } from "../../ci/onboarding-harness/run";
import { buildGapReport, gateGapScenarios } from "../../ci/onboarding-harness/report";
import type { Scenario } from "../../ci/onboarding-harness/types";

/** A gate-eligible scenario (structured, not detection-only) — the kind whose verdict
 *  actually drives the release gate. */
const gating: Scenario = {
  id: "node-too-old",
  image: "images:debian/12",
  seed: [],
  expect: [{ id: "node", state: "warning" }],
  coaching: "structured",
};

const prose: Scenario = {
  id: "git-missing",
  image: "images:alpine/3.21",
  seed: [],
  expect: [{ id: "git", state: "error" }],
  coaching: "prose",
};

describe("abandonRemaining (#2229)", () => {
  it("records every abandoned scenario as unverified, with a reason", () => {
    const results = abandonRemaining([gating, prose]);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.unverified).toBe(true);
      expect(r.reachedGreen).toBe(false);
      expect(r.error).toMatch(/abandoned/i);
    }
    expect(results.map((r) => r.scenarioId)).toEqual(["node-too-old", "git-missing"]);
  });

  it("GATES RED — an abandoned run must never publish a green commit status", () => {
    // The whole point: a host firewall outage verified nothing, so the release gate must
    // not read it as a pass. Unverified is deliberately NOT classified HARNESS ERROR,
    // because that category is de-gated.
    expect(gateGapScenarios(abandonRemaining([gating]))).toHaveLength(1);
  });

  it("carries no duration — an abandoned scenario never ran, so 0s would be a lie", () => {
    expect(abandonRemaining([gating])[0]!.durationMs).toBeUndefined();
  });

  it("reports abandoned scenarios as NOT VERIFIED rather than a crash", () => {
    const report = buildGapReport(abandonRemaining([gating]));
    expect(report).toContain("NOT VERIFIED");
    expect(report).not.toContain("BOOT CRASH");
    expect(report).toContain("## Not verified");
  });

  it("is a no-op on an empty tail (the failure hit the last scenario)", () => {
    expect(abandonRemaining([])).toEqual([]);
  });
});
