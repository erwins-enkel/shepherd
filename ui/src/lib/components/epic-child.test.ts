import { describe, it, expect } from "vitest";
import { childAsIssue, childPrUrl, childUnlocks, childView, openBlockers } from "./epic-child";
import type { EpicChild, EpicChildState, Issue } from "#lib/types.js";

function child(number: number, state: EpicChildState, blockedBy: number[] = []): EpicChild {
  return {
    number,
    title: `Child ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    order: number,
    body: `body ${number}`,
    blockedBy,
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

describe("childView", () => {
  it("maps the child state to its run area", () => {
    expect(childView({ state: "merged" })).toBe("merged");
    expect(childView({ state: "running" })).toBe("session");
    expect(childView({ state: "in-review" })).toBe("session");
    expect(childView({ state: "ready" })).toBe("standing");
    expect(childView({ state: "blocked" })).toBe("standing");
  });
});

describe("openBlockers", () => {
  it("drops merged siblings and keeps open or unknown blockers", () => {
    const siblings = [child(1, "merged"), child(2, "running"), child(3, "blocked", [1, 2, 99])];
    expect(openBlockers(siblings[2], siblings)).toEqual([2, 99]);
  });
  it("is empty without blockers", () => {
    expect(openBlockers(child(1, "ready"), [])).toEqual([]);
  });
});

describe("childUnlocks", () => {
  it("lists open dependents and counts those it alone blocks", () => {
    const siblings = [
      child(1, "merged"),
      child(2, "ready"),
      child(3, "blocked", [2]),
      child(4, "blocked", [1, 2]),
      child(5, "blocked", [2, 6]),
      child(6, "ready"),
      child(7, "merged", [2]),
    ];
    expect(childUnlocks(siblings[1], siblings)).toEqual({ unlocks: [3, 4, 5], parallel: 2 });
  });
  it("is empty when nothing waits on the child", () => {
    expect(childUnlocks(child(1, "ready"), [child(1, "ready")])).toEqual({
      unlocks: [],
      parallel: 0,
    });
  });
});

describe("childAsIssue", () => {
  it("builds an Issue from the record with the open blockers", () => {
    const issue = childAsIssue(child(4, "blocked", [2]), [2]);
    expect(issue).toMatchObject({
      number: 4,
      title: "Child 4",
      body: "body 4",
      url: "https://github.com/o/r/issues/4",
      labels: [],
      assignees: [],
      blockedBy: [2],
    });
  });
  it("prefers the listed issue but keeps the epic's blockers", () => {
    const listed: Issue = {
      number: 4,
      title: "Listed",
      body: "b",
      url: "u",
      labels: ["ui"],
      createdAt: 5,
      assignees: ["a"],
      blockedBy: [9],
    };
    expect(childAsIssue(child(4, "ready"), [], listed)).toEqual({ ...listed, blockedBy: [] });
  });
});

describe("childPrUrl", () => {
  it("is null without a PR", () => {
    expect(childPrUrl(child(4, "running"), "https://x/pull/1")).toBeNull();
  });
  it("prefers the live git url", () => {
    expect(childPrUrl({ ...child(4, "running"), prNumber: 12 }, "https://x/pull/12")).toBe(
      "https://x/pull/12",
    );
  });
  it("swaps the PR number into the issue url otherwise", () => {
    expect(childPrUrl({ ...child(4, "merged"), prNumber: 12 })).toBe(
      "https://github.com/o/r/issues/12",
    );
  });
});
