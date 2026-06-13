import { describe, expect, it } from "bun:test";
import { buildGapReport } from "../../ci/onboarding-harness/report";
import type { ScenarioResult } from "../../ci/onboarding-harness/types";

const results: ScenarioResult[] = [
  {
    scenarioId: "gh-unauthed",
    image: "images:ubuntu/24.04",
    detection: { scenarioId: "gh-unauthed", detected: true, misses: [] },
    appliedVia: "agent",
    reachedGreen: true,
  },
  {
    scenarioId: "tailscale-missing",
    image: "images:ubuntu/24.04",
    detection: {
      scenarioId: "tailscale-missing",
      detected: false,
      misses: [{ id: "tailscale", want: "error", got: "absent" }],
    },
    appliedVia: "agent",
    reachedGreen: false,
    error: "agent gave up",
  },
];

describe("buildGapReport", () => {
  it("summarizes pass/fail counts and lists gaps", () => {
    const md = buildGapReport(results);
    expect(md).toContain("# Onboarding Gap Report");
    expect(md).toContain("1 / 2 scenarios reached green");
    expect(md).toContain("gh-unauthed");
    expect(md).toContain("tailscale-missing");
    expect(md).toContain("tailscale want=error got=absent");
    expect(md).toContain("agent gave up");
  });

  it("marks a detection-but-not-fixed scenario as an advice gap", () => {
    const md = buildGapReport([
      {
        scenarioId: "x",
        image: "i",
        detection: { scenarioId: "x", detected: true, misses: [] },
        appliedVia: "agent",
        reachedGreen: false,
      },
    ]);
    expect(md).toContain("ADVICE GAP");
  });

  it("classifies a by-design no-apply scenario as DETECTION-ONLY and excludes it from the denominator", () => {
    const md = buildGapReport([
      {
        scenarioId: "claude-missing",
        image: "images:fedora/40",
        detection: { scenarioId: "claude-missing", detected: true, misses: [] },
        appliedVia: "skipped",
        reachedGreen: false,
        detectionOnly: true,
      },
      {
        scenarioId: "gh-unauthed",
        image: "i",
        detection: { scenarioId: "gh-unauthed", detected: true, misses: [] },
        appliedVia: "agent",
        reachedGreen: true,
      },
    ]);
    expect(md).toContain("DETECTION-ONLY");
    expect(md).toContain("1 / 1 scenarios reached green"); // claude-missing excluded
    expect(md).not.toContain("## Gaps"); // DETECTION-ONLY is not a gap
  });
});
