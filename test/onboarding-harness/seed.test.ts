import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { seedInstance } from "../../ci/onboarding-harness/seed";
import type { IncusExec } from "../../ci/onboarding-harness/types";

function recorder() {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, run };
}

const scenario = {
  id: "gh-unauthed",
  image: "images:ubuntu/24.04",
  seed: ["rm -rf ~/.config/gh"],
  expect: [{ id: "gh", state: "error" as const }],
  coaching: "prose" as const,
};

describe("seedInstance", () => {
  it("launches, installs the bun baseline, then runs the scenario seed in order", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await seedInstance(d, scenario, "/tmp/shepherd.tar");

    expect(calls[0]![0]).toBe("launch");
    expect(calls[0]!).toContain("images:ubuntu/24.04");
    // stacks default (root disk + NIC) under the shep-onb limits profile
    expect(calls[0]!).toContain("default");
    expect(calls[0]!).toContain("shep-onb");

    const flat = calls.map((c) => c.join(" "));
    // baseline installs bun before the scenario seed runs
    const bunIdx = flat.findIndex((c) => c.includes("bun.sh/install"));
    const seedIdx = flat.findIndex((c) => c.includes("rm -rf ~/.config/gh"));
    expect(bunIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeGreaterThan(bunIdx);
    // bash prereq must be ensured before the bun installer (which pipes to bash)
    const bashIdx = flat.findIndex((c) => c.includes("command -v bash"));
    expect(bashIdx).toBeGreaterThanOrEqual(0);
    expect(bashIdx).toBeLessThan(bunIdx);
    // unzip (bun installer prereq) + a build toolchain (node-pty) are ensured
    expect(flat.some((c) => c.includes("unzip"))).toBe(true);
    expect(flat.some((c) => c.includes("build-essential"))).toBe(true);

    // Arch keyring refresh (#1422) runs BEFORE the first pacman install so a fresh
    // archlinux image doesn't fail unzip on a drifted keyring; guarded on `command -v
    // pacman` so it's a no-op on non-Arch scenarios.
    const keyringIdx = flat.findIndex(
      (c) => c.includes("pacman-key --populate archlinux") && c.includes("archlinux-keyring"),
    );
    expect(keyringIdx).toBeGreaterThanOrEqual(0);
    expect(flat[keyringIdx]).toContain("command -v pacman");
    const unzipIdx = flat.findIndex((c) => c.includes("unzip"));
    expect(keyringIdx).toBeLessThan(unzipIdx);

    // baseline writes the network-free herdr STUB (satisfies the #1313 preflight
    // with zero network) before the scenario seed — NOT a herdr.dev fetch.
    const stubIdx = flat.findIndex((c) => c.includes(".local/bin/herdr") && c.includes("chmod +x"));
    expect(stubIdx).toBeGreaterThanOrEqual(0);
    expect(stubIdx).toBeLessThan(seedIdx);
    // the herdr step must be the stub, never a live herdr.dev install in the baseline
    expect(flat.some((c) => c.includes("herdr.dev"))).toBe(false);
  });

  it("the Arch keyring step owns the keyring and is fail-closed (#1738)", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await seedInstance(d, scenario, "/tmp/shepherd.tar");

    const flat = calls.map((c) => c.join(" "));
    const step = flat.find((c) => c.includes("pacman-key --populate archlinux"))!;
    expect(step).toBeDefined();

    // Stays a clean no-op on the 8 non-Arch (apt/apk/dnf) scenarios.
    expect(step).toContain("command -v pacman");

    // FAIL-CLOSED. `driver.exec` runs this via `sh -c`, which returns only the LAST
    // command's status — and `pacman -Sy --needed archlinux-keyring` exits 0 ("nothing to
    // do") when the version already matches. Without `set -e` a failed init/populate would
    // be swallowed and the step would report success on an EMPTY keyring. Either `set -e`
    // or an unbroken `&&` chain from init through the sync satisfies the contract.
    const failClosed =
      /(^|\n)set -e(\s|$)/.test(step) ||
      /pacman-key --init\s*&&[\s\S]*pacman -Sy[^\n]*archlinux-keyring/.test(step);
    expect(failClosed).toBe(true);

    // Stops the image's OWN boot-time keyring writers BEFORE touching pacman-key, or we
    // race them (#1738): pacman-init.service (After=time-sync.target, so it can fire well
    // after our DNS gate) and the wkd-sync timer (Persistent=true ⇒ boot catch-up run).
    const stopIdx = step.indexOf("systemctl stop");
    const keyIdx = step.indexOf("pacman-key");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeLessThan(keyIdx);
    expect(step).toContain("pacman-init.service");
    expect(step).toContain("archlinux-keyring-wkd-sync.timer");

    // BOUNDED: `systemctl stop` blocks on the unit's job; unbounded it could hang to the
    // 20min RUNNER_TIMEOUT_MS SIGKILL instead of failing fast.
    expect(step).toContain("timeout 120 systemctl stop");
  });

  it("the herdr stub is a CHECKED baseline step (a failure aborts the seed)", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      // Fail only the herdr-stub write; everything else succeeds.
      if (args.join(" ").includes(".local/bin/herdr")) {
        return { stdout: "", stderr: "no space left on device", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    await expect(seedInstance(d, scenario, "/tmp/shepherd.tar")).rejects.toThrow(
      /baseline step failed/,
    );
  });

  it("pushes the Shepherd build tarball into the instance", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await seedInstance(d, scenario, "/tmp/shepherd.tar");
    const push = calls.find((c) => c[0] === "file" && c[1] === "push");
    expect(push).toBeDefined();
    expect(push!).toContain("/tmp/shepherd.tar");
  });
});
