import { describe, expect, it } from "bun:test";
import { REMEDIATIONS, remediationsFor } from "../../ci/onboarding-harness/remediations";
import type { DiagnosticsSnapshot } from "../../src/types";

describe("remediations catalog", () => {
  it("maps known fixable hintKeys to a single shell command", () => {
    expect(REMEDIATIONS.diagnostics_hint_bun_missing).toContain("bun.sh/install");
  });

  it("collects verbatim commands for non-ok checks that have one (skips prose-only and ok)", () => {
    const snap: DiagnosticsSnapshot = {
      checks: [
        { id: "bun", state: "error", hintKey: "diagnostics_hint_bun_missing" },
        { id: "gh", state: "error", hintKey: "diagnostics_hint_gh_not_authenticated" }, // prose-only → skipped
        { id: "git", state: "ok", hintKey: "diagnostics_hint_git_ok" }, // ok → skipped
      ],
      generatedAt: 1,
      overall: "error",
    };
    expect(remediationsFor(snap)).toEqual([REMEDIATIONS["diagnostics_hint_bun_missing"]!]);
  });
});
