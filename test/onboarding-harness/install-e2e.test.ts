import { describe, expect, it } from "bun:test";
import { HERDR_LAST_SUPPORTED_VERSION } from "../../src/herdr-capabilities";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { seedInstance } from "../../ci/onboarding-harness/seed";
import { runScenario } from "../../ci/onboarding-harness/run";
import { SCENARIOS } from "../../ci/onboarding-harness/scenarios";
import type { IncusExec } from "../../ci/onboarding-harness/types";
import type { DiagnosticsSnapshot } from "../../src/types";

const installE2E = SCENARIOS.find((s) => s.id === "install-e2e")!;

/** Snapshot the install-e2e flow probes after install: the auto-fixable set is ok;
 *  gh/tailscale stay non-ok (no gh login / tailnet on a throw-away instance). */
function greenSnapshot(): DiagnosticsSnapshot {
  return {
    checks: [
      { id: "herdr", state: "ok", hintKey: "" },
      { id: "bun", state: "ok", hintKey: "" },
      { id: "node", state: "ok", hintKey: "" },
      { id: "git", state: "ok", hintKey: "" },
      { id: "claude", state: "ok", hintKey: "" },
      { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" },
      { id: "tailscale", state: "error", hintKey: "diagnostics_hint_tailscale_missing" },
    ],
    generatedAt: 1,
    overall: "error",
  };
}

/** Recorder runner: code 0 for everything, but serves a diagnostics snapshot for
 *  the probe call (the `?refresh=1` curl). Boot's poll loop also returns code 0. */
function recorder(snapshot: DiagnosticsSnapshot) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("--version")) {
      // The installed-version assertion (#1896): the harness demands the PINNED herdr, not merely
      // a working one, so the fake must answer as a correctly-pinned host would.
      return { stdout: `herdr ${HERDR_LAST_SUPPORTED_VERSION}\n`, stderr: "", code: 0 };
    }
    if (joined.includes("/api/diagnostics?refresh=1")) {
      return { stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

describe("install-e2e seedInstance", () => {
  it("launches, waits for DNS, pushes the tarball + install.sh, and SKIPS the baseline", async () => {
    const { calls, run } = recorder(greenSnapshot());
    const d = new IncusDriver(run, "shep-onb-");
    await seedInstance(d, installE2E, "/tmp/shepherd.tar", "/repo/deploy/install.sh");

    const flat = calls.map((c) => c.join(" "));
    // launch first
    expect(calls[0]![0]).toBe("launch");
    expect(calls[0]!).toContain("images:ubuntu/24.04");
    // DNS wait runs
    expect(flat.some((c) => c.includes("getent hosts bun.sh"))).toBe(true);
    // pushes BOTH the tarball and install.sh
    const pushes = calls.filter((c) => c[0] === "file" && c[1] === "push");
    expect(pushes.some((c) => c.includes("/tmp/shepherd.tar"))).toBe(true);
    expect(pushes.some((c) => c.includes("/repo/deploy/install.sh"))).toBe(true);
    expect(pushes.some((c) => c.some((a) => a.endsWith("/root/shepherd.tar")))).toBe(true);
    expect(pushes.some((c) => c.some((a) => a.endsWith("/root/install.sh")))).toBe(true);
    // NO baseline: no bun install, no tarball extract to /opt/shepherd, no `bun install`
    expect(flat.some((c) => c.includes("bun.sh/install"))).toBe(false);
    expect(flat.some((c) => c.includes("tar -xf /root/shepherd.tar -C /opt/shepherd"))).toBe(false);
    expect(flat.some((c) => c.includes("bun install"))).toBe(false);
  });

  it("throws when the install script path is omitted", async () => {
    const { run } = recorder(greenSnapshot());
    const d = new IncusDriver(run, "shep-onb-");
    await expect(seedInstance(d, installE2E, "/tmp/shepherd.tar")).rejects.toThrow(
      /requires installScriptPath/,
    );
  });
});

describe("install-e2e runScenario", () => {
  it("runs the real install.sh, boots, probes, reaches green, and tears down", async () => {
    const { calls, run } = recorder(greenSnapshot());
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, installE2E, "/tmp/shepherd.tar");

    const flat = calls.map((c) => c.join(" "));
    // install.sh invoked with the expected env contract (the exec, not the push)
    const installCall = flat.find((c) => c.startsWith("exec") && c.includes("/root/install.sh"));
    expect(installCall).toBeDefined();
    expect(installCall!).toContain("SHEPHERD_SRC=/root/shepherd.tar");
    expect(installCall!).toContain("SHEPHERD_NO_SERVICE=1");
    expect(installCall!).toContain("SHEPHERD_DIR=/opt/shepherd");
    // boot + probe happened
    expect(flat.some((c) => c.includes("src/index.ts"))).toBe(true);
    expect(flat.some((c) => c.includes("/api/diagnostics?refresh=1"))).toBe(true);
    // outcome
    expect(result.reachedGreen).toBe(true);
    expect(result.gateEligible).toBe(true);
    expect(result.appliedVia).toBe("verbatim");
    expect(result.detection.detected).toBe(true);
    // teardown ran (finally → delete)
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("carries installE2E through the catch when install.sh exits non-zero (so it gates as INSTALL GAP, not infra)", async () => {
    const calls: string[][] = [];
    // install.sh exec fails; everything else (launch/push/dns) succeeds.
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      // Fail only the install.sh EXEC (not its file-push during seed).
      if (args[0] === "exec" && args.join(" ").includes("bash /root/install.sh")) {
        return { stdout: "", stderr: "fnm install --lts: network unreachable", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, installE2E, "/tmp/shepherd.tar");

    // The throw path must keep the flag so report.ts classifies it INSTALL GAP, not
    // HARNESS ERROR (which would silently drop it from the gate).
    expect(result.installE2E).toBe(true);
    expect(result.reachedGreen).toBe(false);
    expect(result.gateEligible).toBe(true);
    expect(result.error).toContain("install.sh failed");
    // never reached boot/probe
    expect(calls.some((c) => c.join(" ").includes("src/index.ts"))).toBe(false);
    // still torn down
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("reports red when an expected check stays non-ok after install", async () => {
    const snap = greenSnapshot();
    snap.checks.find((c) => c.id === "herdr")!.state = "error";
    const { calls, run } = recorder(snap);
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, installE2E, "/tmp/shepherd.tar");

    expect(result.reachedGreen).toBe(false);
    expect(result.detection.detected).toBe(false);
    expect(result.detection.misses.some((m) => m.id === "herdr")).toBe(true);
    // still torn down
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });
});

// Sanity: the catalog entry has the contract run.ts/seed.ts branch on.
describe("install-e2e catalog entry", () => {
  it("is installE2E, structured (gate-eligible), with an empty seed", () => {
    expect(installE2E.installE2E).toBe(true);
    expect(installE2E.coaching).toBe("structured");
    expect(installE2E.detectionOnly).toBeUndefined();
    expect(installE2E.seed).toEqual([]);
  });
});
