import { describe, expect, it } from "bun:test";
import { assertDetection } from "../../ci/onboarding-harness/assert";
import type { DiagnosticsSnapshot } from "../../src/types";

function snap(checks: Array<[string, "ok" | "warning" | "error"]>): DiagnosticsSnapshot {
  return {
    checks: checks.map(([id, state]) => ({ id, state, hintKey: `k_${id}` })),
    generatedAt: 1,
    overall: checks.some(([, s]) => s === "error")
      ? "error"
      : checks.some(([, s]) => s === "warning")
        ? "warning"
        : "ok",
  };
}

describe("assertDetection", () => {
  it("detects when every expected check matches its state", () => {
    const r = assertDetection(
      snap([
        ["gh", "error"],
        ["git", "ok"],
      ]),
      "s",
      [{ id: "gh", state: "error" }],
    );
    expect(r.detected).toBe(true);
    expect(r.misses).toEqual([]);
  });

  it("reports a state mismatch as a miss", () => {
    const r = assertDetection(snap([["gh", "warning"]]), "s", [{ id: "gh", state: "error" }]);
    expect(r.detected).toBe(false);
    expect(r.misses).toEqual([{ id: "gh", want: "error", got: "warning" }]);
  });

  it("reports an absent expected check as a miss", () => {
    const r = assertDetection(snap([["git", "ok"]]), "s", [{ id: "gh", state: "error" }]);
    expect(r.misses).toEqual([{ id: "gh", want: "error", got: "absent" }]);
  });
});
