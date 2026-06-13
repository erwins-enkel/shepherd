import { describe, expect, it } from "bun:test";
import { resolveCoaching, buildAgentPrompt } from "../../ci/onboarding-harness/apply";
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
