import { describe, it, expect } from "vitest";
import type { PullRequest } from "$lib/types";
import {
  hideDraftPrs,
  hasConflicts,
  hideConflictPrs,
  hideFailingCiPrs,
  filterByAuthor,
  distinctAuthors,
} from "./prs-panel";

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: "t",
    url: "u",
    author: "alice",
    kind: "regular",
    createdAt: 0,
    isDraft: false,
    mergeable: true,
    checks: "success",
    jobs: [],
    ...overrides,
  };
}

describe("hideDraftPrs", () => {
  const prs = [pr({ number: 1, isDraft: true }), pr({ number: 2, isDraft: false })];
  it("drops drafts when on", () => {
    expect(hideDraftPrs(prs, true).map((p) => p.number)).toEqual([2]);
  });
  it("fails open when off", () => {
    expect(hideDraftPrs(prs, false)).toHaveLength(2);
  });
});

describe("hasConflicts", () => {
  it("true when mergeable false and not draft", () => {
    expect(hasConflicts(pr({ mergeable: false, isDraft: false }))).toBe(true);
  });
  it("false for a draft even if unmergeable", () => {
    expect(hasConflicts(pr({ mergeable: false, isDraft: true }))).toBe(false);
  });
  it("false when host still computing (null)", () => {
    expect(hasConflicts(pr({ mergeable: null }))).toBe(false);
  });
  it("false when mergeable", () => {
    expect(hasConflicts(pr({ mergeable: true }))).toBe(false);
  });
});

describe("hideConflictPrs", () => {
  const prs = [
    pr({ number: 1, mergeable: false }),
    pr({ number: 2, mergeable: true }),
    pr({ number: 3, mergeable: null }),
  ];
  it("drops only conflicting PRs when on", () => {
    expect(hideConflictPrs(prs, true).map((p) => p.number)).toEqual([2, 3]);
  });
  it("fails open when off", () => {
    expect(hideConflictPrs(prs, false)).toHaveLength(3);
  });
});

describe("hideFailingCiPrs", () => {
  const prs = [
    pr({ number: 1, checks: "failure" }),
    pr({ number: 2, checks: "success" }),
    pr({ number: 3, checks: "pending" }),
    pr({ number: 4, checks: "none" }),
  ];
  it("drops only failed-CI PRs when on", () => {
    expect(hideFailingCiPrs(prs, true).map((p) => p.number)).toEqual([2, 3, 4]);
  });
  it("fails open when off", () => {
    expect(hideFailingCiPrs(prs, false)).toHaveLength(4);
  });
});

describe("filterByAuthor", () => {
  const prs = [pr({ number: 1, author: "alice" }), pr({ number: 2, author: "bob" })];
  it("narrows to one author", () => {
    expect(filterByAuthor(prs, "bob").map((p) => p.number)).toEqual([2]);
  });
  it("null selection is identity", () => {
    expect(filterByAuthor(prs, null)).toHaveLength(2);
  });
});

describe("distinctAuthors", () => {
  it("dedupes and sorts case-insensitively", () => {
    const prs = [pr({ author: "Bob" }), pr({ author: "alice" }), pr({ author: "Bob" })];
    expect(distinctAuthors(prs)).toEqual(["alice", "Bob"]);
  });
  it("skips PRs without an author", () => {
    const prs = [pr({ author: "" }), pr({ author: "alice" })];
    expect(distinctAuthors(prs)).toEqual(["alice"]);
  });
});
