import { describe, expect, it } from "bun:test";
import { isConflicting, isDefiniteConflict } from "../src/pr-conflict";

describe("isConflicting (broad — signal + UI)", () => {
  it("dirty is a conflict regardless of mergeable", () => {
    expect(isConflicting({ mergeStateStatus: "dirty", mergeable: null })).toBe(true);
    expect(isConflicting({ mergeStateStatus: "dirty", mergeable: false })).toBe(true);
  });

  it("dirty conflicts on a DRAFT still surface — DRAFT masks BEHIND, not DIRTY", () => {
    // Verified against live PRs #1102/#1088: isDraft true AND mergeStateStatus DIRTY.
    expect(isConflicting({ mergeStateStatus: "dirty", isDraft: true })).toBe(true);
  });

  it("mergeable:false on a non-draft is a conflict", () => {
    expect(isConflicting({ mergeable: false, isDraft: false })).toBe(true);
  });

  it("mergeable:false on a DRAFT is NOT — the Gitea WIP artifact guard", () => {
    expect(isConflicting({ mergeable: false, isDraft: true })).toBe(false);
  });

  it("clean and unknown states are not conflicts", () => {
    expect(isConflicting({ mergeable: true, mergeStateStatus: "clean" })).toBe(false);
    expect(isConflicting({ mergeable: null, mergeStateStatus: "unknown" })).toBe(false);
    expect(isConflicting({})).toBe(false);
  });
});

describe("isDefiniteConflict (gates behaviour — GitHub-shaped)", () => {
  it("dirty qualifies, including with mergeable:null", () => {
    expect(isDefiniteConflict({ mergeStateStatus: "dirty", mergeable: null })).toBe(true);
    expect(isDefiniteConflict({ mergeStateStatus: "dirty", mergeable: false })).toBe(true);
  });

  it("dirty on a draft qualifies — Defect B's only route in", () => {
    expect(isDefiniteConflict({ mergeStateStatus: "dirty", isDraft: true })).toBe(true);
  });

  it("mergeable:false with a settled non-dirty mergeStateStatus qualifies", () => {
    expect(isDefiniteConflict({ mergeable: false, mergeStateStatus: "blocked" })).toBe(true);
    expect(isDefiniteConflict({ mergeable: false, mergeStateStatus: "behind" })).toBe(true);
  });

  it("mergeable:false + unknown does NOT — the poller treats unknown as unsettled", () => {
    expect(isDefiniteConflict({ mergeable: false, mergeStateStatus: "unknown" })).toBe(false);
  });

  it("Gitea (no mergeStateStatus) never qualifies, draft or not", () => {
    // Gitea folds branch-protection into `mergeable`, so a red-but-mergeable PR reads false.
    expect(isDefiniteConflict({ mergeable: false })).toBe(false);
    expect(isDefiniteConflict({ mergeable: false, isDraft: true })).toBe(false);
  });

  it("is strictly narrower than isConflicting", () => {
    const giteaNonDraft = { mergeable: false, isDraft: false };
    expect(isConflicting(giteaNonDraft)).toBe(true);
    expect(isDefiniteConflict(giteaNonDraft)).toBe(false);
  });
});
