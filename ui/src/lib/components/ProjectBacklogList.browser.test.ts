import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import ProjectBacklogList from "./ProjectBacklogList.svelte";
import type { BacklogProject } from "$lib/types";
import { m } from "$lib/paraglide/messages";

function project(path: string, hidden = false): BacklogProject {
  return {
    path,
    display: path,
    slug: "org/repo",
    kind: "github",
    openIssues: 0,
    openPRs: 0,
    prKinds: null,
    workflows: null,
    ciStatus: null,
    hidden,
  };
}

function baseProps(over: Partial<Record<string, unknown>> = {}) {
  return {
    projects: [project("/r/a"), project("/r/b")],
    hiddenProjects: [],
    hiddenCount: 0,
    showHidden: false,
    pinnedPath: null,
    selectedPath: null,
    hasIssues: false,
    hasPRs: false,
    query: "",
    ontoggleissues: () => {},
    ontoggleprs: () => {},
    ontogglehidden: () => {},
    onsearch: () => {},
    onselect: () => {},
    onhide: () => {},
    onaddclone: () => {},
    onaddfork: () => {},
    onaddnewproject: () => {},
    ...over,
  };
}

describe("ProjectBacklogList — hide repos", () => {
  it("no Hidden chip when nothing is hidden", () => {
    render(ProjectBacklogList, baseProps());
    expect(document.body.textContent).not.toContain(m.backlog_filter_hidden({ count: 1 }));
  });

  it("renders a Hidden·N chip when hiddenCount > 0 and toggles on click", async () => {
    const ontogglehidden = vi.fn();
    render(ProjectBacklogList, baseProps({ hiddenCount: 2, ontogglehidden }));
    const chip = [...document.body.querySelectorAll<HTMLButtonElement>(".filter-chip")].find((b) =>
      b.textContent?.includes(m.backlog_filter_hidden({ count: 2 })),
    );
    expect(chip).toBeTruthy();
    chip!.click();
    expect(ontogglehidden).toHaveBeenCalledTimes(1);
  });

  it("renders the dimmed Hidden group and fires onhide(path) for an unhide click", () => {
    const onhide = vi.fn();
    render(
      ProjectBacklogList,
      baseProps({
        hiddenCount: 1,
        showHidden: true,
        hiddenProjects: [project("/r/c", true)],
        onhide,
      }),
    );
    expect(document.body.textContent).toContain(m.backlog_hidden_heading());
    const dimmed = document.body.querySelector(".project-row.dim");
    expect(dimmed).toBeTruthy();
    const eye = dimmed!.querySelector<HTMLButtonElement>(".row-hide");
    eye!.click();
    expect(onhide).toHaveBeenCalledWith("/r/c");
  });

  it("fires onhide(path) for a visible row's hide button", () => {
    const onhide = vi.fn();
    render(ProjectBacklogList, baseProps({ projects: [project("/r/a")], onhide }));
    const row = document.body.querySelector(".project-row:not(.dim)");
    row!.querySelector<HTMLButtonElement>(".row-hide")!.click();
    expect(onhide).toHaveBeenCalledWith("/r/a");
  });

  it("all-repos-hidden shows the hidden-specific hint, not the generic none-match", () => {
    render(
      ProjectBacklogList,
      baseProps({ projects: [], hiddenCount: 2, showHidden: false, query: "" }),
    );
    expect(document.body.textContent).toContain(m.backlog_filter_all_hidden());
    expect(document.body.textContent).not.toContain(m.backlog_filter_none_match());
  });

  it("empty due to a search (not hiding) keeps the generic none-match hint", () => {
    render(
      ProjectBacklogList,
      baseProps({ projects: [], hiddenCount: 2, showHidden: false, query: "zzz" }),
    );
    expect(document.body.textContent).toContain(m.backlog_filter_none_match());
    expect(document.body.textContent).not.toContain(m.backlog_filter_all_hidden());
  });

  it("a search matching only hidden repos shows the Hidden group with no empty banner", () => {
    render(
      ProjectBacklogList,
      baseProps({
        projects: [],
        hiddenCount: 2,
        showHidden: false,
        query: "spike",
        hiddenProjects: [project("/r/spike", true)],
      }),
    );
    // The Hidden group renders; neither empty banner appears above it.
    expect(document.body.querySelector(".project-row.dim")).toBeTruthy();
    expect(document.body.textContent).not.toContain(m.backlog_filter_none_match());
    expect(document.body.textContent).not.toContain(m.backlog_filter_all_hidden());
  });
});

describe("ProjectBacklogList — + Add repo", () => {
  it("shows the trigger and opens the menu, forwarding each action", async () => {
    const onaddclone = vi.fn();
    const onaddfork = vi.fn();
    const onaddnewproject = vi.fn();
    render(ProjectBacklogList, baseProps({ onaddclone, onaddfork, onaddnewproject }));

    await page.getByRole("button", { name: m.backlog_add_repo() }).click();
    await page.getByRole("menuitem", { name: m.newproject_trigger() }).click();
    expect(onaddnewproject).toHaveBeenCalledOnce();
    expect(onaddclone).not.toHaveBeenCalled();
    expect(onaddfork).not.toHaveBeenCalled();
  });
});
