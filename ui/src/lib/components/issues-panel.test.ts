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
import { issueAgeDays } from "./issues-panel";

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
