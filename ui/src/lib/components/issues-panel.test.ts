/**
 * Unit tests for IssuesPanel logic (issues-panel.ts).
 *
 * Follows the backlog-view.test.ts pattern: the Svelte component has no DOM
 * test infrastructure here, so we cover the extracted pure filter the template
 * delegates to.
 */
import { describe, it, expect } from "vitest";
import { filterIssues } from "./issues-panel";
import type { Issue } from "$lib/types";

function issue(number: number, title: string, body = "", labels: string[] = []): Issue {
  return { number, title, body, url: `https://example.test/${number}`, labels, createdAt: 0 };
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
