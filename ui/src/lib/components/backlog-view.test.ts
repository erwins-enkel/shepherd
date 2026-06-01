/**
 * Unit tests for BacklogView logic (backlog-view.ts).
 *
 * BacklogView.svelte has no @testing-library/svelte available in this test
 * suite. We test the extracted pure-logic helpers following the pr-badge.test.ts
 * pattern.
 *
 * Coverage note: tab switching (Svelte state), DOM rendering, and the
 * `$effect` selectedPath initialisation are not covered here; they require DOM
 * rendering infrastructure not present. The assertions below verify the display
 * logic (null → "—", pinned detection, tab label strings) that the template
 * delegates to these functions.
 */
import { describe, it, expect } from "vitest";
import { formatCount, isPinned, issuesTabLabel, prsTabLabel } from "./backlog-view";
import type { BacklogPayload, BacklogProject } from "$lib/types";

function project(path: string, openIssues: number | null, openPRs: number | null): BacklogProject {
  return { path, display: path, slug: "org/repo", kind: "github", openIssues, openPRs };
}

function payload(
  projects: BacklogProject[],
  pinnedPath: string | null = null,
  totals = { openIssues: 0, openPRs: 0 },
): BacklogPayload {
  return { pinnedPath, projects, totals };
}

describe("formatCount", () => {
  it("returns the number as-is for non-null counts", () => {
    expect(formatCount(0)).toBe(0);
    expect(formatCount(5)).toBe(5);
    expect(formatCount(42)).toBe(42);
  });

  it("returns '—' for null counts (the em-dash placeholder)", () => {
    expect(formatCount(null)).toBe("—");
  });
});

describe("isPinned", () => {
  it("returns true when project path matches pinnedPath", () => {
    const p = project("/repos/alpha", 3, 1);
    expect(isPinned(p, "/repos/alpha")).toBe(true);
  });

  it("returns false when project path differs from pinnedPath", () => {
    const p = project("/repos/alpha", 3, 1);
    expect(isPinned(p, "/repos/beta")).toBe(false);
  });

  it("returns false when pinnedPath is null", () => {
    const p = project("/repos/alpha", 3, 1);
    expect(isPinned(p, null)).toBe(false);
  });
});

describe("issuesTabLabel", () => {
  it("includes the openIssues total count from the payload", () => {
    const p = payload([], null, { openIssues: 24, openPRs: 3 });
    const label = issuesTabLabel(p);
    expect(label).toContain("24");
    // Mirrors m.backlog_tab_issues_count({ count: payload.totals.openIssues })
    expect(label).toMatch(/Issues\s*·\s*24/);
  });

  it("shows 0 when no issues", () => {
    const p = payload([], null, { openIssues: 0, openPRs: 0 });
    expect(issuesTabLabel(p)).toContain("0");
  });
});

describe("prsTabLabel", () => {
  it("includes the openPRs total count from the payload", () => {
    const p = payload([], null, { openIssues: 24, openPRs: 3 });
    const label = prsTabLabel(p);
    expect(label).toContain("3");
    // Mirrors m.backlog_tab_prs_count({ count: payload.totals.openPRs })
    expect(label).toMatch(/PRs\s*·\s*3/);
  });

  it("shows 0 when no PRs", () => {
    const p = payload([], null, { openIssues: 10, openPRs: 0 });
    expect(prsTabLabel(p)).toContain("0");
  });
});

describe("BacklogView display logic — integration of helpers", () => {
  it("project with null openIssues renders as '—'", () => {
    const p = project("/repos/null-proj", null, null);
    expect(formatCount(p.openIssues)).toBe("—");
    expect(formatCount(p.openPRs)).toBe("—");
  });

  it("pinned project is identified correctly", () => {
    const pinnedPath = "/repos/alpha";
    const alpha = project(pinnedPath, 10, 2);
    const beta = project("/repos/beta", 3, 1);
    const pl = payload([alpha, beta], pinnedPath);

    expect(isPinned(alpha, pl.pinnedPath)).toBe(true);
    expect(isPinned(beta, pl.pinnedPath)).toBe(false);
  });

  it("tab labels contain both issue and PR totals from payload", () => {
    const pl = payload([], "/repos/alpha", { openIssues: 15, openPRs: 7 });
    expect(issuesTabLabel(pl)).toContain("15");
    expect(prsTabLabel(pl)).toContain("7");
  });

  /**
   * PRs tab shows backlog_prs_soon placeholder (not a spinner).
   *
   * The PRs tab in BacklogView.svelte renders `.prs-soon` with
   * m.backlog_prs_soon() = "PR details coming soon" and does NOT render a
   * loading spinner class. We assert the message key value here since
   * the full message catalog is available via the paraglide runtime.
   */
  it("backlog_prs_soon message key yields a non-empty string (placeholder, not spinner)", async () => {
    // Import the compiled paraglide message directly.
    const { backlog_prs_soon } = await import("$lib/paraglide/messages");
    const text = backlog_prs_soon();
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    // Must not look like a loading/spinner label
    expect(text.toLowerCase()).not.toContain("loading");
    expect(text.toLowerCase()).not.toContain("spinner");
  });
});
