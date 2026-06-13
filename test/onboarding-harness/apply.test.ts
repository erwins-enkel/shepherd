import { describe, expect, it } from "bun:test";
import {
  resolveCoaching,
  buildAgentPrompt,
  applyVerbatim,
} from "../../ci/onboarding-harness/apply";
import { IncusDriver } from "../../ci/onboarding-harness/incus";
import type { DiagnosticsSnapshot } from "../../src/types";

const snap: DiagnosticsSnapshot = {
  checks: [
    { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" },
    { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" },
  ],
  generatedAt: 1,
  overall: "error",
};

describe("resolveCoaching", () => {
  it("resolves non-ok check hintKeys to their EN message text", () => {
    const messages = {
      diagnostics_hint_gh_not_authenticated: "Run `gh auth login` to authenticate.",
    };
    const lines = resolveCoaching(snap, messages);
    expect(lines).toEqual([{ id: "gh", text: "Run `gh auth login` to authenticate." }]);
  });

  it("skips ok checks and falls back to the raw key when a message is missing", () => {
    const lines = resolveCoaching(snap, {});
    expect(lines).toEqual([{ id: "gh", text: "diagnostics_hint_gh_not_authenticated" }]);
  });
});

describe("buildAgentPrompt", () => {
  it("includes the coaching text and a clear success instruction", () => {
    const p = buildAgentPrompt([{ id: "gh", text: "Run gh auth login." }]);
    expect(p).toContain("Run gh auth login.");
    expect(p.toLowerCase()).toContain("healthy");
  });
});

describe("applyVerbatim", () => {
  it("runs each harness-catalog remediation for non-ok checks inside the instance", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    const d = new IncusDriver(run, "shep-onb-");
    const snap = {
      checks: [{ id: "bun", state: "error" as const, hintKey: "diagnostics_hint_bun_missing" }],
      generatedAt: 1,
      overall: "error" as const,
    };
    const ok = await applyVerbatim(d, "bun-missing", snap);
    expect(ok).toBe(true);
    expect(calls[0]!.join(" ")).toContain("bun.sh/install");
  });
});
