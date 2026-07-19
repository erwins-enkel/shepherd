import { describe, expect, it } from "vitest";
import { isConflicting } from "./pr-conflict";

describe("isConflicting (UI copy — must track src/pr-conflict.ts)", () => {
  it("dirty is a conflict regardless of mergeable", () => {
    expect(isConflicting({ mergeStateStatus: "dirty", mergeable: null })).toBe(true);
    expect(isConflicting({ mergeStateStatus: "dirty", mergeable: false })).toBe(true);
  });

  it("a dirty DRAFT still chips — DRAFT masks BEHIND, not DIRTY", () => {
    expect(isConflicting({ mergeStateStatus: "dirty", isDraft: true })).toBe(true);
  });

  it("mergeable:false on a non-draft is a conflict", () => {
    expect(isConflicting({ mergeable: false, isDraft: false })).toBe(true);
  });

  it("mergeable:false on a DRAFT is NOT — the Gitea WIP artifact guard", () => {
    expect(isConflicting({ mergeable: false, isDraft: true })).toBe(false);
  });

  it("clean / unknown / empty are not conflicts", () => {
    expect(isConflicting({ mergeable: true, mergeStateStatus: "clean" })).toBe(false);
    expect(isConflicting({ mergeable: null, mergeStateStatus: "unknown" })).toBe(false);
    expect(isConflicting({})).toBe(false);
  });
});
