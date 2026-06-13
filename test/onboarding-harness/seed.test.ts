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

    const flat = calls.map((c) => c.join(" "));
    // baseline installs bun before the scenario seed runs
    const bunIdx = flat.findIndex((c) => c.includes("bun.sh/install"));
    const seedIdx = flat.findIndex((c) => c.includes("rm -rf ~/.config/gh"));
    expect(bunIdx).toBeGreaterThanOrEqual(0);
    expect(seedIdx).toBeGreaterThan(bunIdx);
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
