import { describe, it, expect } from "vitest";
import { prBadgeLabel, prBadgeIsDraft, prMergeAvailable } from "./pr-badge";
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

describe("prMergeAvailable", () => {
  const open = { state: "open" as const, number: 12, checks: "success" as const };

  it("returns false for absent git", () => {
    expect(prMergeAvailable(undefined)).toBe(false);
  });
  it("is available for a clean open github PR", () => {
    expect(prMergeAvailable(git({ ...open }))).toBe(true);
  });
  it("is available for a gitea PR without mergeStateStatus when checks pass", () => {
    expect(prMergeAvailable(git({ ...open, kind: "gitea" }))).toBe(true);
  });
  it("returns false for a local-forge session", () => {
    expect(prMergeAvailable(git({ ...open, kind: "local" }))).toBe(false);
  });
  it("returns false for non-open states", () => {
    expect(prMergeAvailable(git({ ...open, state: "merged" }))).toBe(false);
    expect(prMergeAvailable(git({ ...open, state: "closed" }))).toBe(false);
    expect(prMergeAvailable(git({ ...open, state: "none" }))).toBe(false);
  });
  it("returns false without a PR number", () => {
    expect(prMergeAvailable(git({ ...open, number: undefined }))).toBe(false);
  });
  it("returns false for a draft PR", () => {
    expect(prMergeAvailable(git({ ...open, isDraft: true }))).toBe(false);
  });
  it("returns false when the branch is not mergeable (conflict)", () => {
    expect(prMergeAvailable(git({ ...open, mergeable: false }))).toBe(false);
  });
  it("treats mergeable null (host still computing) as available", () => {
    expect(prMergeAvailable(git({ ...open, mergeable: null }))).toBe(true);
  });
  it("returns false when mergeStateStatus is blocked or behind", () => {
    expect(prMergeAvailable(git({ ...open, mergeStateStatus: "blocked" }))).toBe(false);
    expect(prMergeAvailable(git({ ...open, mergeStateStatus: "behind" }))).toBe(false);
  });
  it("trusts a clean/unstable mergeStateStatus over failing checks", () => {
    expect(prMergeAvailable(git({ ...open, mergeStateStatus: "clean", checks: "failure" }))).toBe(
      true,
    );
    expect(
      prMergeAvailable(git({ ...open, mergeStateStatus: "unstable", checks: "failure" })),
    ).toBe(true);
  });
  it("falls back to checks when mergeStateStatus is unknown or absent", () => {
    expect(prMergeAvailable(git({ ...open, mergeStateStatus: "unknown", checks: "failure" }))).toBe(
      false,
    );
    expect(prMergeAvailable(git({ ...open, checks: "failure" }))).toBe(false);
    expect(prMergeAvailable(git({ ...open, checks: "pending" }))).toBe(true);
  });
});

describe("prMergeAvailable — conflict recognition", () => {
  const base = { kind: "github", state: "open", number: 7, checks: "success" } as any;

  it("is false for a dirty PR even while mergeable is still null", () => {
    // The mergeStateStatus branch excludes only blocked/behind, so without the isConflicting
    // guard this offered a merge button on a PR that cannot merge.
    expect(prMergeAvailable({ ...base, mergeable: null, mergeStateStatus: "dirty" })).toBe(false);
  });

  it("stays true for a clean PR", () => {
    expect(prMergeAvailable({ ...base, mergeable: true, mergeStateStatus: "clean" })).toBe(true);
  });
});
