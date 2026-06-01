/**
 * Unit tests for IssuesPanel logic (issues-panel.ts).
 *
 * IssuesPanel.svelte has no @testing-library/svelte available, so we test
 * the extracted pure-logic companions following the pr-badge.test.ts pattern.
 *
 * Coverage note: the component's internal fetch (listIssues) and Svelte
 * reactivity are not covered here; that requires DOM rendering infrastructure
 * not present in this test suite.
 */
import { describe, it, expect } from "vitest";
import { filterIssues, issueAgeDays } from "./issues-panel";
import type { Issue } from "$lib/types";

function issue(number: number, labels: string[], createdAt = 0): Issue {
  return { number, title: `Issue ${number}`, body: "body", url: "u", labels, createdAt };
}

describe("filterIssues", () => {
  it("returns all issues when filterLabels is undefined", () => {
    const issues = [issue(1, ["bug"]), issue(2, ["feature"])];
    expect(filterIssues(issues, undefined)).toEqual(issues);
  });

  it("returns all issues when filterLabels is empty array", () => {
    const issues = [issue(1, ["bug"]), issue(2, [])];
    expect(filterIssues(issues, [])).toEqual(issues);
  });

  it("keeps issues that have at least one label in filterLabels (OR semantics)", () => {
    const issues = [
      issue(1, ["bug"]),
      issue(2, ["enhancement"]),
      issue(3, ["documentation"]),
      issue(4, ["bug", "enhancement"]),
    ];
    const visible = filterIssues(issues, ["bug", "enhancement"]);
    expect(visible.map((i) => i.number)).toEqual([1, 2, 4]);
    expect(visible.map((i) => i.number)).not.toContain(3);
  });

  it("excludes issues that have no matching labels", () => {
    const issues = [issue(1, ["documentation"]), issue(2, ["question"])];
    const visible = filterIssues(issues, ["bug"]);
    expect(visible).toHaveLength(0);
  });

  it("works when an issue has multiple labels and only one matches", () => {
    const issues = [issue(1, ["bug", "wontfix"])];
    const visible = filterIssues(issues, ["bug", "enhancement"]);
    expect(visible).toHaveLength(1);
  });

  it("preserves stale-guard safety: does not mutate the input array", () => {
    const issues = [issue(1, ["bug"])];
    const copy = [...issues];
    filterIssues(issues, ["bug"]);
    expect(issues).toEqual(copy);
  });
});

describe("issueAgeDays", () => {
  it("returns 0 for a just-created issue (same ms)", () => {
    const now = Date.now();
    expect(issueAgeDays(now, now)).toBe(0);
  });

  it("returns the correct number of whole days", () => {
    const now = 1_000_000_000_000; // arbitrary fixed point
    const threeDaysAgo = now - 3 * 86_400_000;
    expect(issueAgeDays(threeDaysAgo, now)).toBe(3);
  });

  it("floors fractional days", () => {
    const now = 1_000_000_000_000;
    const almostTwoDays = now - (2 * 86_400_000 - 1);
    expect(issueAgeDays(almostTwoDays, now)).toBe(1);
  });

  it("returns 0 (clamped) if createdAt is somehow in the future", () => {
    const now = 1_000_000_000_000;
    expect(issueAgeDays(now + 86_400_000, now)).toBe(0);
  });

  it("derives days matching the backlog_open_since_days usage in the template", () => {
    // Template: Math.floor((Date.now() - issue.createdAt) / 86_400_000)
    const now = 1_700_000_000_000;
    const createdAt = now - 7 * 86_400_000;
    expect(issueAgeDays(createdAt, now)).toBe(7);
  });
});
