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
import {
  formatCount,
  isPinned,
  selectedProject,
  issuesTabLabel,
  prsTabLabel,
  actionsTabLabel,
} from "./backlog-view";
import type { BacklogPayload, BacklogProject } from "$lib/types";

function project(
  path: string,
  openIssues: number | null,
  openPRs: number | null,
  workflows: number | null = null,
): BacklogProject {
  return { path, display: path, slug: "org/repo", kind: "github", openIssues, openPRs, workflows };
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

describe("selectedProject", () => {
  it("returns null when nothing is selected", () => {
    const pl = payload([project("/repos/alpha", 5, 1)]);
    expect(selectedProject(pl, null)).toBeNull();
  });

  it("returns the project whose path matches the selection", () => {
    const alpha = project("/repos/alpha", 5, 1);
    const beta = project("/repos/beta", 2, 0);
    const pl = payload([alpha, beta]);
    expect(selectedProject(pl, "/repos/beta")).toBe(beta);
  });

  it("returns null when the selected path is not among the projects", () => {
    const pl = payload([project("/repos/alpha", 5, 1)]);
    expect(selectedProject(pl, "/repos/ghost")).toBeNull();
  });
});

describe("issuesTabLabel", () => {
  it("scopes the count to the selected project, not the all-repos total", () => {
    // Selected repo has 0 open issues even though other repos contribute to the
    // aggregate — the badge must read the per-repo value (the reported bug).
    const sel = project("/repos/alpha", 0, 0);
    const label = issuesTabLabel(sel);
    expect(label).toMatch(/Issues\s*·\s*0/);
  });

  it("includes the selected project's openIssues count", () => {
    expect(issuesTabLabel(project("/repos/a", 24, 3))).toMatch(/Issues\s*·\s*24/);
  });

  it("drops the count (bare label) when nothing is selected", () => {
    expect(issuesTabLabel(null)).toBe("Issues");
  });

  it("drops the count when the per-repo count is unknown (null)", () => {
    expect(issuesTabLabel(project("/repos/a", null, null))).toBe("Issues");
  });
});

describe("prsTabLabel", () => {
  it("includes the selected project's openPRs count", () => {
    expect(prsTabLabel(project("/repos/a", 24, 3))).toMatch(/PRs\s*·\s*3/);
  });

  it("scopes to the selected repo: 5 total but 0 here → 'PRs · 0'", () => {
    expect(prsTabLabel(project("/repos/a", 0, 0))).toMatch(/PRs\s*·\s*0/);
  });

  it("drops the count (bare label) when nothing is selected", () => {
    expect(prsTabLabel(null)).toBe("PRs");
  });

  it("drops the count when the per-repo count is unknown (null)", () => {
    expect(prsTabLabel(project("/repos/a", null, null))).toBe("PRs");
  });
});

describe("actionsTabLabel", () => {
  it("shows the workflows-defined count for the selected project", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3))).toMatch(/Actions\s*·\s*3/);
  });

  it("shows 'Actions · 0' for a github repo with no workflow files", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, 0))).toMatch(/Actions\s*·\s*0/);
  });

  it("drops the count (bare label) when nothing is selected", () => {
    expect(actionsTabLabel(null)).toBe("Actions");
  });

  it("drops the count for non-github forges (workflows null)", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, null))).toBe("Actions");
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

  it("tab labels reflect the selected project resolved from the payload", () => {
    const alpha = project("/repos/alpha", 15, 7, 4);
    const pl = payload([alpha], "/repos/alpha");
    const sel = selectedProject(pl, "/repos/alpha");
    expect(issuesTabLabel(sel)).toContain("15");
    expect(prsTabLabel(sel)).toContain("7");
    expect(actionsTabLabel(sel)).toContain("4");
  });

  /**
   * The PRs tab is now a live master/detail (PrsPanel), not a placeholder.
   * Spawning a review task seeds the New Task prompt with this template, which
   * must interpolate the PR number and carry its URL on a second line.
   */
  it("newtask_pr_review_template interpolates the PR number and url", async () => {
    const { newtask_pr_review_template } = await import("$lib/paraglide/messages");
    const text = newtask_pr_review_template({ number: 142, url: "https://example/pr/142" });
    expect(text).toContain("142");
    expect(text).toContain("https://example/pr/142");
  });
});
