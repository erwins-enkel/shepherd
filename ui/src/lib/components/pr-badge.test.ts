import { describe, it, expect } from "vitest";
import { prBadgeLabel } from "./pr-badge";
import type { GitState } from "../types";

function git(over: Partial<GitState>): GitState {
  return { kind: "github", state: "none", checks: "none", deployConfigured: false, ...over };
}

describe("prBadgeLabel", () => {
  it("returns null for an absent entry (renders nothing)", () => {
    expect(prBadgeLabel(undefined)).toBeNull();
  });
  it("labels state none as NO PR", () => {
    expect(prBadgeLabel(git({ state: "none" }))).toBe("NO PR");
  });
  it("labels an open PR with its number", () => {
    expect(prBadgeLabel(git({ state: "open", number: 12 }))).toBe("PR #12");
  });
  it("labels a merged PR", () => {
    expect(prBadgeLabel(git({ state: "merged", number: 12 }))).toBe("MERGED ✓");
  });
  it("labels a closed PR", () => {
    expect(prBadgeLabel(git({ state: "closed", number: 12 }))).toBe("CLOSED");
  });
});
