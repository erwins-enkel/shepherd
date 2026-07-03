/**
 * Unit tests for IssuesPanel logic (issues-panel.ts).
 *
 * Follows the backlog-view.test.ts pattern: the Svelte component has no DOM
 * test infrastructure here, so we cover the extracted pure filter the template
 * delegates to.
 */
import { describe, it, expect } from "vitest";
import {
  filterIssues,
  hideOthers,
  hideActive,
  hideSubIssues,
  sortEpicsFirst,
  ACTIVE_LABEL,
} from "./issues-panel";
import type { Issue } from "$lib/types";

function issue(
  number: number,
  title: string,
  body = "",
  labels: string[] = [],
  assignees: string[] = [],
): Issue {
  return {
    number,
    title,
    body,
    url: `https://example.test/${number}`,
    labels,
    createdAt: 0,
    assignees,
  };
}

const issues = [
  issue(122, "Post-Delivery Follow-Up E-Mail", "Kundenzufriedenheit nach Lieferung", [
    "enhancement",
  ]),
  issue(117, "Creator-/Influencer-Tracking", "Link + Gutscheincode als Paket", [
    "enhancement",
    "shepherd:active",
  ]),
  issue(9, "Fix broken images", "", ["bug"]),
];

describe("filterIssues", () => {
  it("returns all issues for an empty or whitespace query", () => {
    expect(filterIssues(issues, "")).toEqual(issues);
    expect(filterIssues(issues, "   ")).toEqual(issues);
  });

  it("matches title case-insensitively", () => {
    expect(filterIssues(issues, "follow-up")).toEqual([issues[0]]);
  });

  it("matches body text", () => {
    expect(filterIssues(issues, "gutscheincode")).toEqual([issues[1]]);
  });

  it("matches labels", () => {
    expect(filterIssues(issues, "bug")).toEqual([issues[2]]);
    expect(filterIssues(issues, "shepherd:active")).toEqual([issues[1]]);
  });

  it("matches the issue number with and without a leading #", () => {
    expect(filterIssues(issues, "122")).toEqual([issues[0]]);
    expect(filterIssues(issues, "#122")).toEqual([issues[0]]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterIssues(issues, "zzz-no-match")).toEqual([]);
  });
});

describe("hideOthers", () => {
  const me = "octocat";
  const unassigned = issue(1, "Unassigned", "", [], []);
  const mine = issue(2, "Mine", "", [], [me]);
  const theirs = issue(3, "Theirs", "", [], ["someone-else"]);
  const mineAndTheirs = issue(4, "Shared", "", [], ["someone-else", me]);
  const all = [unassigned, mine, theirs, mineAndTheirs];

  it("when enabled, shows unassigned + mine + shared, hides others' issues", () => {
    expect(hideOthers(all, me, true)).toEqual([unassigned, mine, mineAndTheirs]);
  });

  it("keeps an issue assigned to me alone", () => {
    expect(hideOthers([mine], me, true)).toEqual([mine]);
  });

  it("keeps an unassigned issue", () => {
    expect(hideOthers([unassigned], me, true)).toEqual([unassigned]);
  });

  it("hides an issue assigned only to others", () => {
    expect(hideOthers([theirs], me, true)).toEqual([]);
  });

  it("keeps an issue assigned to me and others", () => {
    expect(hideOthers([mineAndTheirs], me, true)).toEqual([mineAndTheirs]);
  });

  it("fails open when disabled — returns all issues", () => {
    expect(hideOthers(all, me, false)).toEqual(all);
  });

  it("fails open when the viewer is null — returns all issues", () => {
    expect(hideOthers(all, null, true)).toEqual(all);
  });

  it("does not throw on a stale payload missing assignees", () => {
    // Simulate an old-shape issue (e.g. mid rolling-deploy) whose payload predates
    // the `assignees` field — the `?? []` guard must keep it from throwing.
    const stale = {
      number: 1,
      title: "Unassigned",
      body: "",
      url: "https://example.test/1",
      labels: [],
      createdAt: 0,
    } as unknown as Issue;
    expect(() => hideOthers([stale], me, true)).not.toThrow();
    expect(hideOthers([stale], me, true)).toEqual([stale]);
  });
});

describe("hideActive", () => {
  const plain = issue(1, "Plain", "", ["bug"]);
  const active = issue(2, "Claimed", "", ["enhancement", ACTIVE_LABEL]);
  const all = [plain, active];

  it("when enabled, drops issues labeled shepherd:active", () => {
    expect(hideActive(all, true)).toEqual([plain]);
  });

  it("keeps an issue without the active label", () => {
    expect(hideActive([plain], true)).toEqual([plain]);
  });

  it("fails open when disabled — returns all issues incl. active ones", () => {
    expect(hideActive(all, false)).toEqual(all);
  });

  it("does not throw on a stale payload missing labels", () => {
    const stale = {
      number: 3,
      title: "No labels field",
      body: "",
      url: "https://example.test/3",
      createdAt: 0,
      assignees: [],
    } as unknown as Issue;
    expect(() => hideActive([stale], true)).not.toThrow();
    expect(hideActive([stale], true)).toEqual([stale]);
  });
});

describe("hideSubIssues", () => {
  const subOnly = issue(1, "Sub-issue only");
  const subAndParent = issue(2, "Mid-level epic");
  const normalIssue = issue(3, "Regular issue");
  const all = [subOnly, subAndParent, normalIssue];

  it("when enabled, drops an issue in subIssues but not in epicParents", () => {
    const subs = new Set<number>([1]);
    const parents = new Set<number>([]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual([subAndParent, normalIssue]);
  });

  it("keeps an issue that is both in subIssues and epicParents (mid-level epic)", () => {
    const subs = new Set<number>([1, 2]);
    const parents = new Set<number>([2]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual([subAndParent, normalIssue]);
  });

  it("keeps an issue absent from subIssues", () => {
    const subs = new Set<number>([]);
    const parents = new Set<number>([]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual(all);
  });

  it("fails open when disabled — returns all issues unchanged", () => {
    const subs = new Set<number>([1, 2]);
    const parents = new Set<number>([2]);
    expect(hideSubIssues(all, false, subs, parents)).toEqual(all);
  });

  it("fails open when subIssues is empty — returns all issues unchanged", () => {
    const subs = new Set<number>([]);
    const parents = new Set<number>([2]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual(all);
  });
});

describe("sortEpicsFirst", () => {
  const a = issue(122, "Regular A");
  const epic1 = issue(100, "Epic one");
  const b = issue(117, "Regular B");
  const epic2 = issue(90, "Epic two");
  const all = [a, epic1, b, epic2];

  it("moves epic parents to the front", () => {
    const parents = new Set<number>([100, 90]);
    expect(sortEpicsFirst(all, parents)).toEqual([epic1, epic2, a, b]);
  });

  it("preserves relative order within each group (stable)", () => {
    // epic2 appears after epic1 in the input, and a before b — both orders kept.
    const parents = new Set<number>([100, 90]);
    const result = sortEpicsFirst(all, parents);
    expect(result.map((i) => i.number)).toEqual([100, 90, 122, 117]);
  });

  it("is an identity copy when there are no epic parents", () => {
    const result = sortEpicsFirst(all, new Set<number>());
    expect(result).toEqual(all);
    expect(result).not.toBe(all); // new array, input not mutated
  });

  it("returns all issues when every issue is an epic parent", () => {
    const parents = new Set<number>([122, 100, 117, 90]);
    expect(sortEpicsFirst(all, parents)).toEqual(all);
  });
});
