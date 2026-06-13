import { describe, expect, it } from "bun:test";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import { probeDiagnostics } from "../../ci/onboarding-harness/probe";
import type { IncusExec } from "../../ci/onboarding-harness/types";

describe("probeDiagnostics", () => {
  it("curls the diagnostics endpoint inside the instance and parses the snapshot", async () => {
    const snapshot = {
      checks: [{ id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" }],
      generatedAt: 5,
      overall: "error",
    };
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<IncusExec> => {
      calls.push(args);
      return { stdout: JSON.stringify(snapshot), stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = await probeDiagnostics(d, "gh-unauthed");
    expect(snap.overall).toBe("error");
    expect(snap.checks[0].id).toBe("gh");
    // exec'd a curl against the loopback diagnostics endpoint with refresh
    const cmd = calls[0].join(" ");
    expect(cmd).toContain("curl");
    expect(cmd).toContain("/api/diagnostics?refresh=1");
  });
});
