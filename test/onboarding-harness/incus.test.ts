import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import type { IncusExec } from "../../ci/onboarding-harness/types";

function recorder(reply: Partial<IncusExec> = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0, ...reply };
  };
  return { calls, run };
}

describe("IncusDriver", () => {
  it("launches a system container with the managed-name prefix and STACKED profiles", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.launch("images:ubuntu/24.04", "gh-unauthed", { profiles: ["default", "shep-onb"] });
    // `default` MUST be stacked (not replaced) or the instance loses its root disk.
    expect(calls[0]).toEqual([
      "launch",
      "images:ubuntu/24.04",
      "shep-onb-gh-unauthed",
      "--profile",
      "default",
      "--profile",
      "shep-onb",
    ]);
  });

  it("adds --vm when the scenario requests a VM", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.launch("images:ubuntu/24.04", "kernel-x", { vm: true });
    expect(calls[0]).toContain("--vm");
  });

  it("execs a command inside the instance via -- separator", async () => {
    const { calls, run } = recorder({ stdout: "ok" });
    const d = new IncusDriver(run, "shep-onb-");
    const r = await d.exec("gh-unauthed", ["sh", "-c", "echo hi"]);
    expect(calls[0]).toEqual(["exec", "shep-onb-gh-unauthed", "--", "sh", "-c", "echo hi"]);
    expect(r.stdout).toBe("ok");
  });

  it("force-deletes an instance", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.delete("gh-unauthed");
    expect(calls[0]).toEqual(["delete", "shep-onb-gh-unauthed", "--force"]);
  });

  it("lists only managed instances and sweeps them", async () => {
    const { calls, run } = recorder({
      stdout: JSON.stringify([
        { name: "shep-onb-a" },
        { name: "unrelated" },
        { name: "shep-onb-b" },
      ]),
    });
    const d = new IncusDriver(run, "shep-onb-");
    expect(await d.listManaged()).toEqual(["shep-onb-a", "shep-onb-b"]);
    await d.sweep();
    // listManaged (1) + one delete per managed instance (2)
    expect(calls.filter((c) => c[0] === "delete")).toHaveLength(2);
  });
});
