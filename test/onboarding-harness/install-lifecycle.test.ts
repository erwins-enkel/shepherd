import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { runScenario } from "../../ci/onboarding-harness/run";
import { SCENARIOS } from "../../ci/onboarding-harness/scenarios";
import type { IncusExec } from "../../ci/onboarding-harness/types";
import type { DiagnosticsSnapshot } from "../../src/types";

const lifecycle = SCENARIOS.find((s) => s.id === "install-e2e-service")!;

/** Snapshot the lifecycle flow probes after install-through-the-unit: the
 *  auto-fixable set is ok; gh/tailscale stay non-ok (no gh login / tailnet). */
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

/** Recorder runner: code 0 for everything; serves a diagnostics snapshot for the
 *  probe call and `active` for the `systemctl --user is-active shepherd` check. */
function recorder(snapshot: DiagnosticsSnapshot) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("/api/diagnostics?refresh=1")) {
      return { stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
    }
    if (joined.includes("is-active shepherd")) {
      return { stdout: "active\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

describe("install-e2e-service runScenario (lifecycle)", () => {
  it("git-checks-out /opt/shepherd, establishes the user bus, installs through the unit, asserts active, and reaches green", async () => {
    const { calls, run } = recorder(greenSnapshot());
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, lifecycle, "/tmp/shepherd.tar");

    const flat = calls.map((c) => c.join(" "));

    // git checkout of /opt/shepherd (git init + commit) precedes everything.
    const gitInit = flat.find((c) => c.startsWith("exec") && c.includes("git init -q -b main"));
    expect(gitInit).toBeDefined();
    expect(gitInit!).toContain("tar -xf /root/shepherd.tar -C /opt/shepherd");
    expect(gitInit!).toContain("harness seed");

    // user bus established: enable-linger + bus-socket wait.
    const bus = flat.find((c) => c.startsWith("exec") && c.includes("loginctl enable-linger root"));
    expect(bus).toBeDefined();
    expect(bus!).toContain("/run/user/0/bus");

    // #1112: the unit's EnvironmentFile is seeded with the operator bearer BEFORE install,
    // so the started service's config.token matches the gated diagnostics probe's bearer.
    const envSeed = flat.find((c) => c.startsWith("exec") && c.includes("/root/.shepherd/env"));
    expect(envSeed).toBeDefined();
    expect(envSeed!).toContain("SHEPHERD_TOKEN="); // written into the unit's EnvironmentFile
    expect(envSeed!).toContain("onboarding-harness-probe-token");

    // install.sh THROUGH the service path: correct env, and NO SHEPHERD_NO_SERVICE.
    const install = flat.find((c) => c.startsWith("exec") && c.includes("bash /root/install.sh"));
    expect(install).toBeDefined();
    expect(install!).toContain("XDG_RUNTIME_DIR=/run/user/0");
    expect(install!).toContain("USER=root");
    expect(install!).toContain("SHEPHERD_SRC=/opt/shepherd");
    expect(install!).toContain("SHEPHERD_DIR=/opt/shepherd");
    expect(install!).not.toContain("SHEPHERD_NO_SERVICE");

    // unit active-check ran; the manual `bun src/index.ts` boot did NOT.
    expect(flat.some((c) => c.includes("systemctl --user is-active shepherd"))).toBe(true);
    expect(flat.some((c) => c.includes("src/index.ts"))).toBe(false);

    // health-check through the running unit + probe.
    expect(flat.some((c) => c.includes("/api/diagnostics?refresh=1"))).toBe(true);

    // ORDER: git-checkout → bus → env-seed → install → is-active.
    const idx = (needle: string) => flat.findIndex((c) => c.includes(needle));
    expect(idx("git init -q -b main")).toBeLessThan(idx("loginctl enable-linger root"));
    expect(idx("loginctl enable-linger root")).toBeLessThan(idx("/root/.shepherd/env"));
    expect(idx("/root/.shepherd/env")).toBeLessThan(idx("bash /root/install.sh"));
    expect(idx("bash /root/install.sh")).toBeLessThan(idx("systemctl --user is-active shepherd"));

    // outcome
    expect(result.reachedGreen).toBe(true);
    expect(result.gateEligible).toBe(true);
    expect(result.appliedVia).toBe("verbatim");
    expect(result.installE2E).toBe(true);
    expect(result.detection.detected).toBe(true);
    // teardown ran (finally → delete)
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("carries installE2E through the catch when install.sh exits non-zero (gates as INSTALL GAP)", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      // Fail only the install.sh EXEC (not its file-push during seed).
      if (args[0] === "exec" && args.join(" ").includes("bash /root/install.sh")) {
        return { stdout: "", stderr: "provision: enable --now failed", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, lifecycle, "/tmp/shepherd.tar");

    expect(result.installE2E).toBe(true);
    expect(result.reachedGreen).toBe(false);
    expect(result.gateEligible).toBe(true);
    expect(result.error).toContain("install.sh (service) failed");
    // never reached the unit active-check or the boot.
    expect(calls.some((c) => c.join(" ").includes("is-active shepherd"))).toBe(false);
    expect(calls.some((c) => c.join(" ").includes("src/index.ts"))).toBe(false);
    // still torn down
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("fails closed when the user bus never comes up", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      if (args[0] === "exec" && args.join(" ").includes("loginctl enable-linger root")) {
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, lifecycle, "/tmp/shepherd.tar");

    expect(result.installE2E).toBe(true);
    expect(result.reachedGreen).toBe(false);
    expect(result.error).toContain("user bus did not come up");
    // install.sh never ran after the bus failure.
    expect(calls.some((c) => c.join(" ").includes("bash /root/install.sh"))).toBe(false);
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });

  it("fails closed when the shepherd unit is not active after install", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      if (args.join(" ").includes("is-active shepherd")) {
        return { stdout: "failed\n", stderr: "", code: 3 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const result = await runScenario(d, lifecycle, "/tmp/shepherd.tar");

    expect(result.installE2E).toBe(true);
    expect(result.reachedGreen).toBe(false);
    expect(result.error).toContain("shepherd user unit not active");
    expect(calls.some((c) => c[0] === "delete")).toBe(true);
  });
});

// Sanity: the catalog entry has the contract run.ts branches on.
describe("install-e2e-service catalog entry", () => {
  it("is installE2E + serviceLifecycle, structured (gate-eligible), with an empty seed", () => {
    expect(lifecycle.installE2E).toBe(true);
    expect(lifecycle.serviceLifecycle).toBe(true);
    expect(lifecycle.coaching).toBe("structured");
    expect(lifecycle.detectionOnly).toBeUndefined();
    expect(lifecycle.seed).toEqual([]);
  });
});
