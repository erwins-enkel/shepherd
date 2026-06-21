import { describe, expect, it } from "bun:test";
import {
  buildGapReport,
  gateGapScenarios,
  statusDescription,
} from "../../ci/onboarding-harness/report";
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

  it("classifies a THROWN install-e2e (install.sh non-zero / boot crash) as an INSTALL GAP that gates, not a HARNESS ERROR", () => {
    // This is the runScenario catch-block sentinel for install-e2e: error set,
    // detection never ran (detected:false, no misses) — identical in shape to a
    // pre-detection infra throw. Because it carries installE2E, it must be an
    // INSTALL GAP (gates, stays in the denominator), NOT excluded as infra.
    const md = buildGapReport([
      {
        scenarioId: "install-e2e",
        image: "images:ubuntu/24.04",
        detection: { scenarioId: "install-e2e", detected: false, misses: [] },
        appliedVia: "skipped",
        reachedGreen: false,
        gateEligible: true,
        installE2E: true,
        error: "install.sh failed in install-e2e:\nfnm install --lts: network unreachable",
      },
    ]);
    expect(md).toContain("INSTALL GAP");
    expect(md).not.toContain("HARNESS ERROR");
    expect(md).not.toContain("## Harness errors");
    expect(md).toContain("## Gaps");
    expect(md).toContain("install.sh failed in install-e2e");
    // Stays in the denominator and is NOT green → a real installer regression gates.
    expect(md).toContain("0 / 1 scenarios reached green");
    expect(md).not.toContain("harness error");
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

  it("excludes a gate-eligible launch-failure from the gate (exact #926 shape)", () => {
    // A gate-eligible scenario that threw with a launch failure (the #926 bug shape).
    // Previously, gateGapScenarios returned it and flipped the gate red.
    // Now it must be excluded: gateGapScenarios returns [].
    const launchFail: ScenarioResult = {
      scenarioId: "fedora-git-missing",
      image: "images:fedora/42",
      detection: { scenarioId: "fedora-git-missing", detected: false, misses: [] },
      appliedVia: "skipped",
      reachedGreen: false,
      gateEligible: true,
      error: "incus launch failed: image couldn't be found",
    };
    expect(gateGapScenarios([launchFail])).toHaveLength(0);
  });

  it("non-launch pre-detection throw (BOOT CRASH) is a gate gap that renders BOOT CRASH, not DETECTION GAP", () => {
    // An instance that launched but crashed before detection (e.g. boot probe timeout)
    // is NOT a harness error — it must gate. Classified as BOOT CRASH, counted in denominator.
    const bootCrash: ScenarioResult = {
      scenarioId: "ubuntu-bun-missing",
      image: "images:ubuntu/24.04",
      detection: { scenarioId: "ubuntu-bun-missing", detected: false, misses: [] },
      appliedVia: "skipped",
      reachedGreen: false,
      gateEligible: true,
      error: "Shepherd did not come up",
    };
    expect(gateGapScenarios([bootCrash])).toHaveLength(1);
    const md = buildGapReport([bootCrash]);
    expect(md).toContain("BOOT CRASH");
    expect(md).not.toContain("DETECTION GAP");
    // Stays in denominator: 0 / 1 reached green
    expect(md).toContain("0 / 1 scenarios reached green");
  });

  it("any launch-failure message is de-gated (not just image-rot)", () => {
    // A name-collision or disk-full launch failure must also be de-gated and
    // classified as HARNESS ERROR (infra), not BOOT CRASH.
    const nameCollision: ScenarioResult = {
      scenarioId: "fedora-git-missing",
      image: "images:fedora/42",
      detection: { scenarioId: "fedora-git-missing", detected: false, misses: [] },
      appliedVia: "skipped",
      reachedGreen: false,
      gateEligible: true,
      error: "incus launch failed: name already in use",
    };
    expect(gateGapScenarios([nameCollision])).toHaveLength(0);
    const md = buildGapReport([nameCollision]);
    expect(md).toContain("HARNESS ERROR");
    expect(md).not.toContain("BOOT CRASH");
    expect(md).not.toContain("DETECTION GAP");
  });

  it("statusDescription excludes harness errors from denominator and appends a note", () => {
    // One green gate scenario + one gate-eligible launch-failure harness error.
    // statusDescription must return "1/1 gate scenarios green" (NOT "1/2") and note the harness error.
    const greenScenario: ScenarioResult = {
      scenarioId: "herdr-missing",
      image: "images:archlinux",
      detection: { scenarioId: "herdr-missing", detected: true, misses: [] },
      appliedVia: "verbatim",
      reachedGreen: true,
      gateEligible: true,
    };
    const launchFail: ScenarioResult = {
      scenarioId: "fedora-git-missing",
      image: "images:fedora/42",
      detection: { scenarioId: "fedora-git-missing", detected: false, misses: [] },
      appliedVia: "skipped",
      reachedGreen: false,
      gateEligible: true,
      error: "incus launch failed: image couldn't be found",
    };
    const desc = statusDescription([greenScenario, launchFail]);
    expect(desc).toContain("1/1 gate scenarios green");
    expect(desc).not.toContain("1/2");
    expect(desc).toContain("harness error");
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
