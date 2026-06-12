import { describe, it, expect } from "vitest";
import { prBadgeLabel, prBadgeIsDraft } from "./pr-badge";
import type { GitState } from "../types";

function git(over: Partial<GitState>): GitState {
  return { kind: "github", state: "none", checks: "none", deployConfigured: false, ...over };
}

describe("prBadgeLabel", () => {
  it("returns null for an absent entry (renders nothing)", () => {
    expect(prBadgeLabel(undefined)).toBeNull();
  });
  it("renders nothing (null) for state none", () => {
    expect(prBadgeLabel(git({ state: "none" }))).toBeNull();
  });
  it("labels an open PR with its number", () => {
    expect(prBadgeLabel(git({ state: "open", number: 12 }))).toBe("PR #12");
  });
  it("labels a merged PR", () => {
    expect(prBadgeLabel(git({ state: "merged", number: 12 }))).toBe("✓ MERGED");
  });
  it("labels a closed PR", () => {
    expect(prBadgeLabel(git({ state: "closed", number: 12 }))).toBe("CLOSED");
  });
});

describe("prBadgeIsDraft", () => {
  it("returns false for absent git", () => {
    expect(prBadgeIsDraft(undefined)).toBe(false);
  });
  it("returns false for a non-open PR even if isDraft is true", () => {
    expect(prBadgeIsDraft(git({ state: "merged", isDraft: true }))).toBe(false);
    expect(prBadgeIsDraft(git({ state: "closed", isDraft: true }))).toBe(false);
    expect(prBadgeIsDraft(git({ state: "none", isDraft: true }))).toBe(false);
  });
  it("returns true when state is open and isDraft is true", () => {
    expect(prBadgeIsDraft(git({ state: "open", isDraft: true }))).toBe(true);
  });
  it("returns false when state is open but isDraft is false", () => {
    expect(prBadgeIsDraft(git({ state: "open", isDraft: false }))).toBe(false);
  });
  it("returns false when state is open and isDraft is absent", () => {
    expect(prBadgeIsDraft(git({ state: "open" }))).toBe(false);
  });
});
