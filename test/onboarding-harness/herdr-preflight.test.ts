import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { runScenario } from "../../ci/onboarding-harness/run";
import { SCENARIOS } from "../../ci/onboarding-harness/scenarios";
import { HERDR_LAST_SUPPORTED_VERSION } from "../../src/herdr-capabilities";
import { HERDR_MISSING_EXIT_CODE, HERDR_MISSING_MARKER } from "../../src/preflight";
import type { IncusExec } from "../../ci/onboarding-harness/types";
import type { DiagnosticsSnapshot } from "../../src/types";

const herdrMissing = SCENARIOS.find((s) => s.id === "herdr-missing")!;

/** After the remediation re-installs herdr, the re-boot probe sees herdr `ok`
 *  (the other throw-away-host non-ok checks are irrelevant to this scenario). */
function greenAfterFix(): DiagnosticsSnapshot {
  return {
    checks: [
      { id: "herdr", state: "ok", hintKey: "diagnostics_hint_herdr_ok" },
      { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" },
    ],
    generatedAt: 1,
    overall: "error",
  };
}

/** The foreground fail-fast boot is the ONLY `src/index.ts` invocation carrying
 *  `timeout` (bootExpectingPreflightExit); the re-boot uses `setsid`. Keying on
 *  `timeout` lets the recorder answer the two boots differently. */
const isFailFastBoot = (joined: string): boolean =>
  joined.includes("src/index.ts") && joined.includes("timeout");

/** Recorder: fail-fast boot returns the given exit code + banner output; the
 *  diagnostics probe returns `snapshot`; everything else succeeds (code 0). */
function recorder(
  failFastCode: number,
  snapshot: DiagnosticsSnapshot,
  installedHerdr: string = HERDR_LAST_SUPPORTED_VERSION,
) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--version")) {
      // The installed-version assertion (#1896): the harness demands the PINNED herdr, not merely
      // a working one, so the fake answers as a correctly-pinned host would — unless a test
      // overrides it to prove the assertion actually bites.
      return { stdout: `herdr ${installedHerdr}\n`, stderr: "", code: 0 };
    }
    if (isFailFastBoot(joined)) {
      const output = failFastCode === HERDR_MISSING_EXIT_CODE ? `⚠  ${HERDR_MISSING_MARKER}\n` : "";
      return { stdout: output, stderr: "", code: failFastCode };
    }
    if (joined.includes("/api/diagnostics?refresh=1")) {
      return { stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

describe("herdr-missing catalog entry", () => {
  it("is preflightFailFast, structured (gate-eligible), and removes herdr in its seed", () => {
    expect(herdrMissing.preflightFailFast).toBe(true);
    expect(herdrMissing.coaching).toBe("structured");
    expect(herdrMissing.detectionOnly).toBeUndefined();
    expect(herdrMissing.seed.some((c) => c.includes("herdr"))).toBe(true);
  });
});

describe("herdr-missing runScenario (fail-fast preflight path)", () => {
  it("asserts fail-fast (exit 78 + banner), applies the verbatim herdr install, re-boots to green, and tears down", async () => {
    const { calls, run } = recorder(HERDR_MISSING_EXIT_CODE, greenAfterFix());
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, herdrMissing, "/tmp/shepherd.tar");

    const flat = calls.map((c) => c.join(" "));
    // Foreground fail-fast boot happened (timeout guard, no setsid/token).
    expect(flat.some((c) => isFailFastBoot(c))).toBe(true);
    // The REAL verbatim remediation ran (production REMEDIATIONS → herdr.dev install).
    expect(
      flat.some((c) => c.includes(`/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-`)),
    ).toBe(true);
    // Re-boot used the normal detached launch (setsid) + probed diagnostics.
    expect(flat.some((c) => c.includes("src/index.ts") && c.includes("setsid"))).toBe(true);
    expect(flat.some((c) => c.includes("/api/diagnostics?refresh=1"))).toBe(true);
    // Outcome: detected + green, verbatim, gate-eligible.
    expect(result.detection.detected).toBe(true);
    expect(result.reachedGreen).toBe(true);
    expect(result.appliedVia).toBe("verbatim");
    expect(result.gateEligible).toBe(true);
    // Teardown ran (finally → delete).
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("fail-closes when the install lands an UNPINNED herdr, even though the check reads ok", async () => {
    // The teeth behind the pin (#1896). `herdr: ok` alone cannot catch an unpinned install while
    // HERDR_LAST_SUPPORTED_VERSION happens to equal herdr's latest release — so the scenario reads
    // the installed version and refuses anything but the pin. Without this, the day herdr ships
    // past the ceiling a silently-unpinned install would sail through green.
    const { run } = recorder(HERDR_MISSING_EXIT_CODE, greenAfterFix(), "9.9.9");
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, herdrMissing, "/tmp/shepherd.tar");

    expect(result.reachedGreen).toBe(false);
    expect(result.error).toContain("9.9.9");
    expect(result.error).toContain(HERDR_LAST_SUPPORTED_VERSION);
  });

  it("fail-closes (gating BOOT CRASH) when boot does NOT fail-fast — a timeout kill (124) is never a pass", async () => {
    const { calls, run } = recorder(124, greenAfterFix()); // timeout kill, not exit 78
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, herdrMissing, "/tmp/shepherd.tar");

    // Threw before detection → runScenario's catch: not green, still gate-eligible,
    // installE2E flag absent so report.ts classifies it BOOT CRASH (which gates).
    expect(result.reachedGreen).toBe(false);
    expect(result.detection.detected).toBe(false);
    expect(result.gateEligible).toBe(true);
    expect(result.installE2E).toBeUndefined();
    expect(result.error).toContain("expected herdr fail-fast");
    // Never proceeded to the remediation after a non-78 boot.
    expect(
      calls
        .map((c) => c.join(" "))
        .some((c) => c.includes(`/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-`)),
    ).toBe(false);
    // Still torn down.
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });
});
