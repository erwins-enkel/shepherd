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
    gateEligible: false,
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
    gateEligible: false,
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
        gateEligible: false,
      },
    ]);
    expect(md).toContain("ADVICE GAP");
  });

  it("classifies a pre-detection throw (image-not-found / boot crash) as HARNESS ERROR, not a detection gap, and excludes it from the denominator", () => {
    const md = buildGapReport([
      {
        scenarioId: "git-missing",
        image: "images:alpine/3.21",
        // The catch-block sentinel: threw in seed/boot before detection ran, so
        // detection never evaluated Shepherd (no misses recorded).
        detection: { scenarioId: "git-missing", detected: false, misses: [] },
        appliedVia: "skipped",
        reachedGreen: false,
        gateEligible: false,
        error: "incus launch failed: image couldn't be found",
      },
      {
        scenarioId: "gh-unauthed",
        image: "i",
        detection: { scenarioId: "gh-unauthed", detected: true, misses: [] },
        appliedVia: "agent",
        reachedGreen: true,
        gateEligible: false,
      },
    ]);
    expect(md).toContain("HARNESS ERROR");
    expect(md).toContain("## Harness errors");
    expect(md).toContain("incus launch failed: image couldn't be found");
    // The instance never booted — it is NOT a product detection gap.
    expect(md).not.toContain("DETECTION GAP");
    expect(md).not.toContain("## Gaps");
    // Excluded from the green ratio: a scenario that couldn't boot didn't get a
    // fair attempt, so it must not drag the denominator (would read as a regression).
    expect(md).toContain("1 / 1 scenarios reached green");
    expect(md).toContain("1 harness error");
  });

  it("keeps a post-detection apply error (real detection miss recorded) as a DETECTION GAP, not a harness error", () => {
    const md = buildGapReport([
      {
        scenarioId: "tailscale-missing",
        image: "i",
        detection: {
          scenarioId: "tailscale-missing",
          detected: false,
          misses: [{ id: "tailscale", want: "error", got: "absent" }],
        },
        appliedVia: "agent",
        reachedGreen: false,
        gateEligible: false,
        error: "agent gave up",
      },
    ]);
    expect(md).toContain("DETECTION GAP");
    expect(md).not.toContain("HARNESS ERROR");
    expect(md).toContain("0 / 1 scenarios reached green"); // stays in the denominator
  });

  it("classifies a red install-e2e result as an INSTALL GAP, not a DETECTION GAP", () => {
    const md = buildGapReport([
      {
        scenarioId: "install-e2e",
        image: "images:ubuntu/24.04",
        // install-e2e has no seeded defect — `detected:false` here means the host
        // didn't reach green after install.sh, i.e. an installer regression.
        detection: {
          scenarioId: "install-e2e",
          detected: false,
          misses: [{ id: "bun", want: "ok", got: "absent" }],
        },
        appliedVia: "verbatim",
        reachedGreen: false,
        gateEligible: true,
        installE2E: true,
      },
    ]);
    expect(md).toContain("INSTALL GAP");
    expect(md).not.toContain("DETECTION GAP");
    expect(md).toContain("## Gaps");
    expect(md).toContain("bun want=ok got=absent");
    expect(md).toContain("0 / 1 scenarios reached green");
  });

  it("classifies a green install-e2e result as PASS like the others", () => {
    const md = buildGapReport([
      {
        scenarioId: "install-e2e",
        image: "images:ubuntu/24.04",
        detection: { scenarioId: "install-e2e", detected: true, misses: [] },
        appliedVia: "verbatim",
        reachedGreen: true,
        gateEligible: true,
        installE2E: true,
      },
    ]);
    expect(md).toContain("PASS");
    expect(md).not.toContain("INSTALL GAP");
    expect(md).not.toContain("## Gaps");
    expect(md).toContain("1 / 1 scenarios reached green");
  });

  it("classifies a by-design no-apply scenario as DETECTION-ONLY and excludes it from the denominator", () => {
    const md = buildGapReport([
      {
        scenarioId: "claude-missing",
        image: "images:fedora/42",
        detection: { scenarioId: "claude-missing", detected: true, misses: [] },
        appliedVia: "skipped",
        reachedGreen: false,
        detectionOnly: true,
        gateEligible: false,
      },
      {
        scenarioId: "gh-unauthed",
        image: "i",
        detection: { scenarioId: "gh-unauthed", detected: true, misses: [] },
        appliedVia: "agent",
        reachedGreen: true,
        gateEligible: false,
      },
    ]);
    expect(md).toContain("DETECTION-ONLY");
    expect(md).toContain("1 / 1 scenarios reached green"); // claude-missing excluded
    expect(md).not.toContain("## Gaps"); // DETECTION-ONLY is not a gap
  });
});
