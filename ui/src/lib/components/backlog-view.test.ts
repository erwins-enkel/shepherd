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
  actionsTabState,
  filterProjects,
  partitionRecents,
  RECENT_LIMIT,
} from "./backlog-view";
import type { BacklogPayload, BacklogProject } from "$lib/types";

function project(
  path: string,
  openIssues: number | null,
  openPRs: number | null,
  workflows: number | null = null,
  ciStatus: BacklogProject["ciStatus"] = null,
): BacklogProject {
  return {
    path,
    display: path,
    slug: "org/repo",
    kind: "github",
    openIssues,
    openPRs,
    prKinds: null,
    workflows,
    ciStatus,
  };
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

  it("shows the failing marker when the selected repo's CI is failing", () => {
    // ciStatus "failure" wins over the workflows-defined count.
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3, "failure"))).toMatch(/failing/i);
  });

  it("shows the workflows count (not failing) when CI is healthy", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3, "success"))).toMatch(/Actions\s*·\s*3/);
  });

  it("shows the workflows count when CI status is unknown (null)", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3, null))).toMatch(/Actions\s*·\s*3/);
  });
});

describe("actionsTabState (shared source of truth for tab + label)", () => {
  it("returns failing when CI is failing, even with a workflow count", () => {
    expect(actionsTabState(project("/repos/a", 0, 0, 3, "failure"))).toEqual({ kind: "failing" });
  });

  it("returns the count (carrying the value) when CI is healthy", () => {
    expect(actionsTabState(project("/repos/a", 0, 0, 3, "success"))).toEqual({
      kind: "count",
      count: 3,
    });
  });

  it("returns bare when nothing is selected", () => {
    expect(actionsTabState(null)).toEqual({ kind: "bare" });
  });

  it("returns bare when workflows is null (non-github) and CI not failing", () => {
    expect(actionsTabState(project("/repos/a", 0, 0, null, null))).toEqual({ kind: "bare" });
  });
});

describe("filterProjects", () => {
  // Fixed corpus spanning every issues/PRs combination, incl. null and 0 counts.
  const both = project("/repos/both", 3, 2); // issues>0 AND prs>0
  const issuesOnly = project("/repos/issues-only", 5, 0); // issues>0, prs=0
  const prsOnly = project("/repos/prs-only", 0, 4); // issues=0, prs>0
  const neither = project("/repos/neither", 0, 0); // both 0
  const nullIssues = project("/repos/null-issues", null, 6); // issues null, prs>0
  const nullPRs = project("/repos/null-prs", 7, null); // issues>0, prs null
  const projects = [both, issuesOnly, prsOnly, neither, nullIssues, nullPRs];

  it("returns all projects unchanged when both flags are off", () => {
    expect(filterProjects(projects, { hasIssues: false, hasPRs: false })).toEqual(projects);
  });

  it("keeps only projects with openIssues > 0 when hasIssues is on", () => {
    expect(filterProjects(projects, { hasIssues: true, hasPRs: false })).toEqual([
      both,
      issuesOnly,
      nullPRs,
    ]);
  });

  it("keeps only projects with openPRs > 0 when hasPRs is on", () => {
    expect(filterProjects(projects, { hasIssues: false, hasPRs: true })).toEqual([
      both,
      prsOnly,
      nullIssues,
    ]);
  });

  it("intersects (AND) when both flags are on — needs issues>0 AND prs>0", () => {
    expect(filterProjects(projects, { hasIssues: true, hasPRs: true })).toEqual([both]);
  });

  it("fails closed on null/0 counts: null openIssues is excluded when hasIssues is on", () => {
    const result = filterProjects(projects, { hasIssues: true, hasPRs: false });
    expect(result).not.toContain(nullIssues); // null fails closed
    expect(result).not.toContain(prsOnly); // 0 is not > 0
    expect(result).not.toContain(neither);
  });

  it("fails closed on null/0 counts: null openPRs is excluded when hasPRs is on", () => {
    const result = filterProjects(projects, { hasIssues: false, hasPRs: true });
    expect(result).not.toContain(nullPRs); // null fails closed
    expect(result).not.toContain(issuesOnly); // 0 is not > 0
    expect(result).not.toContain(neither);
  });

  it("returns an empty array when every project is excluded", () => {
    const allEmpty = [project("/repos/a", 0, 0), project("/repos/b", null, null)];
    expect(filterProjects(allEmpty, { hasIssues: true, hasPRs: true })).toEqual([]);
  });
});

describe("partitionRecents", () => {
  // Same ranking criteria as the New Task repo picker (RepoSelect): recent agent
  // count desc, then lastUsedAt desc, then name asc — capped at RECENT_LIMIT.
  function recentProject(
    path: string,
    recentAgentCount: number | null,
    lastUsedAt?: number,
  ): BacklogProject {
    return { ...project(path, 0, 0), recentAgentCount, lastUsedAt };
  }

  it("hoists repos with recent agents, most agents first", () => {
    const a = recentProject("/repos/a", 2);
    const b = recentProject("/repos/b", 9);
    const c = recentProject("/repos/c", null);
    const { recents, rest } = partitionRecents([a, b, c]);
    expect(recents).toEqual([b, a]);
    expect(rest).toEqual([c]);
  });

  it("tie-breaks equal counts by most-recently-used", () => {
    const older = recentProject("/repos/older", 3, 100);
    const newer = recentProject("/repos/newer", 3, 200);
    expect(partitionRecents([older, newer]).recents).toEqual([newer, older]);
  });

  it("tie-breaks equal count + lastUsedAt by name (path basename) ascending", () => {
    const zeta = recentProject("/repos/zeta", 3, 100);
    const alpha = recentProject("/repos/alpha", 3, 100);
    expect(partitionRecents([zeta, alpha]).recents).toEqual([alpha, zeta]);
  });

  it("caps the group at RECENT_LIMIT and leaves the overflow in rest", () => {
    const ps = [5, 4, 3, 2, 1].map((n, i) => recentProject(`/repos/p${i}`, n));
    const { recents, rest } = partitionRecents(ps);
    expect(RECENT_LIMIT).toBe(3);
    expect(recents).toEqual(ps.slice(0, 3));
    expect(rest).toEqual(ps.slice(3));
  });

  it("excludes zero/null/missing counts — no recent agents, no pin", () => {
    const zero = recentProject("/repos/zero", 0);
    const nul = recentProject("/repos/null", null);
    const missing = project("/repos/missing", 1, 1);
    const { recents, rest } = partitionRecents([zero, nul, missing]);
    expect(recents).toEqual([]);
    expect(rest).toEqual([zero, nul, missing]);
  });

  it("keeps rest in the original (server-sorted) order and never duplicates a repo", () => {
    const a = recentProject("/repos/a", null);
    const b = recentProject("/repos/b", 7);
    const c = recentProject("/repos/c", null);
    const { recents, rest } = partitionRecents([a, b, c]);
    expect(rest).toEqual([a, c]);
    const all = [...recents, ...rest].map((p) => p.path);
    expect(new Set(all).size).toBe(all.length);
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
