import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import ProjectRow from "./ProjectRow.svelte";
import type { BacklogProject } from "$lib/types";
import { m } from "$lib/paraglide/messages";

function project(partial: Partial<BacklogProject> = {}): BacklogProject {
  return {
    path: "/repo/a",
    display: "repo a",
    slug: "repo-a",
    kind: "github",
    openIssues: 0,
    openPRs: 0,
    prKinds: null,
    workflows: null,
    ciStatus: null,
    hidden: false,
    ...partial,
  };
}

describe("ProjectRow PR-kind counts", () => {
  it("shows regular count as the PR number plus both bot badges", async () => {
    render(ProjectRow, {
      project: project({ openPRs: 4, prKinds: { regular: 2, dependabot: 1, release: 1 } }),
      pinned: false,
      selected: false,
      onselect: () => {},
      onhide: () => {},
    });
    // prominent count = regular (2), not openPRs (4)
    const prs = document.body.querySelector(".count-prs");
    expect(prs?.textContent?.trim()).toBe("2");
    await expect
      .element(page.getByText(m.prkind_dependabot_badge({ count: 1 })))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.prkind_release_badge({ count: 1 }))).toBeInTheDocument();
  });

  it("release-only repo: PR count is 0 and only the release badge renders", async () => {
    render(ProjectRow, {
      project: project({ openPRs: 1, prKinds: { regular: 0, dependabot: 0, release: 1 } }),
      pinned: false,
      selected: false,
      onselect: () => {},
      onhide: () => {},
    });
    const prs = document.body.querySelector(".count-prs");
    expect(prs?.textContent?.trim()).toBe("0");
    await expect.element(page.getByText(m.prkind_release_badge({ count: 1 }))).toBeInTheDocument();
    await expect
      .element(page.getByText(m.prkind_dependabot_badge({ count: 0 })))
      .not.toBeInTheDocument();
    expect(document.body.querySelectorAll(".bot-note").length).toBe(1);
  });

  it("all-regular repo: shows the count and no badges", async () => {
    render(ProjectRow, {
      project: project({ openPRs: 3, prKinds: { regular: 3, dependabot: 0, release: 0 } }),
      pinned: false,
      selected: false,
      onselect: () => {},
      onhide: () => {},
    });
    const prs = document.body.querySelector(".count-prs");
    expect(prs?.textContent?.trim()).toBe("3");
    expect(document.body.querySelector(".bot-note")).toBeNull();
  });

  it("null prKinds (Gitea fallback): renders openPRs and no badges", async () => {
    render(ProjectRow, {
      project: project({ kind: "gitea", openPRs: 5, prKinds: null }),
      pinned: false,
      selected: false,
      onselect: () => {},
      onhide: () => {},
    });
    const prs = document.body.querySelector(".count-prs");
    expect(prs?.textContent?.trim()).toBe("5");
    expect(document.body.querySelector(".bot-note")).toBeNull();
  });
});
