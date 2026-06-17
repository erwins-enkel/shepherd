import { describe, expect, it } from "bun:test";
import { IncusDriver, HARNESS_PROFILE } from "../../ci/onboarding-harness/incus";
import type { IncusExec } from "../../ci/onboarding-harness/types";

/** Fixed-reply recorder: every call returns the same reply. Keeps existing tests working. */
function recorder(reply: Partial<IncusExec> = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0, ...reply };
  };
  return { calls, run };
}

/** Per-argv recorder: maps argv-prefix → reply; falls back to `{code:0}` for unmatched calls. */
function argvRecorder(
  replies: Array<{ match: (args: string[]) => boolean; reply: Partial<IncusExec> }>,
) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusExec> => {
    calls.push(args);
    const found = replies.find((r) => r.match(args));
    return { stdout: "", stderr: "", code: 0, ...(found?.reply ?? {}) };
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

describe("ensureProfile", () => {
  it("happy path: issues profile create, profile set with correct values, and device add in order", async () => {
    const { calls, run } = recorder();
    const d = new IncusDriver(run, "shep-onb-");
    await d.ensureProfile();

    // Step 1: profile create
    expect(calls[0]).toEqual(["profile", "create", "shep-onb"]);

    // Step 2: profile set — must include limits.memory immediately followed by the
    // constant's value (NOT a second literal), plus limits.cpu and security.nesting.
    const setCall = calls[1];
    expect(setCall[0]).toBe("profile");
    expect(setCall[1]).toBe("set");
    expect(setCall[2]).toBe("shep-onb");
    const memIdx = setCall.indexOf("limits.memory");
    expect(memIdx).toBeGreaterThan(-1);
    expect(setCall[memIdx + 1]).toBe(HARNESS_PROFILE.config["limits.memory"]);
    expect(setCall).toContain("limits.cpu");
    const cpuIdx = setCall.indexOf("limits.cpu");
    expect(setCall[cpuIdx + 1]).toBe(HARNESS_PROFILE.config["limits.cpu"]);
    expect(setCall).toContain("security.nesting");
    const nestIdx = setCall.indexOf("security.nesting");
    expect(setCall[nestIdx + 1]).toBe(HARNESS_PROFILE.config["security.nesting"]);

    // Step 3: device add
    expect(calls[2]).toEqual([
      "profile",
      "device",
      "add",
      "shep-onb",
      "tun",
      "unix-char",
      "path=/dev/net/tun",
    ]);

    // Exactly 3 calls total
    expect(calls).toHaveLength(3);
  });

  it("tolerates existing profile: code:1 from profile create does not throw, still runs set + device add", async () => {
    const { calls, run } = argvRecorder([
      {
        match: (args) => args[0] === "profile" && args[1] === "create",
        reply: { code: 1, stderr: "Profile already exists" },
      },
    ]);
    const d = new IncusDriver(run, "shep-onb-");
    await expect(d.ensureProfile()).resolves.toBeUndefined();
    expect(calls.some((c) => c[1] === "set")).toBe(true);
    expect(calls.some((c) => c[1] === "device")).toBe(true);
  });

  it("tolerates existing device: code:1 from profile device add does not throw", async () => {
    const { calls, run } = argvRecorder([
      {
        match: (args) => args[0] === "profile" && args[1] === "device",
        reply: { code: 1, stderr: "Device already exists" },
      },
    ]);
    const d = new IncusDriver(run, "shep-onb-");
    await expect(d.ensureProfile()).resolves.toBeUndefined();
    expect(calls.some((c) => c[1] === "device")).toBe(true);
  });

  it("fails closed on set: code:1 from profile set causes ensureProfile() to throw", async () => {
    const { run } = argvRecorder([
      {
        match: (args) => args[0] === "profile" && args[1] === "set",
        reply: { code: 1, stderr: "permission denied" },
      },
    ]);
    const d = new IncusDriver(run, "shep-onb-");
    await expect(d.ensureProfile()).rejects.toThrow();
  });
});
