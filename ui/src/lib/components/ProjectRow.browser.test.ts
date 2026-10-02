import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import ProjectRow from "./ProjectRow.svelte";
import type { BacklogProject } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { projectIcons } from "$lib/projectIcons.svelte";

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

function renderRow(p: BacklogProject) {
  render(ProjectRow, {
    project: p,
    pinned: false,
    selected: false,
    onselect: () => {},
    onhide: () => {},
  });
  return document.body.querySelector<HTMLElement>(".project-row")!;
}

describe("ProjectRow compact counts", () => {
  it("shows one number — the open issues — and no PR or bot badges", () => {
    const row = renderRow(
      project({ openIssues: 7, openPRs: 4, prKinds: { regular: 2, dependabot: 1, release: 1 } }),
    );
    expect(row.querySelector(".row-count")?.textContent?.trim()).toBe("7");
    expect(row.querySelectorAll(".row-count").length).toBe(1);
    expect(row.textContent).not.toContain("+1d");
    expect(row.textContent).not.toContain("+1r");
  });

  it("shows — when the issue count is unknown", () => {
    const row = renderRow(project({ openIssues: null }));
    expect(row.querySelector(".row-count")?.textContent?.trim()).toBe("—");
    expect(row.getAttribute("aria-description")).toContain(m.backlog_row_tip_issues_unknown());
  });

  it("moves code PRs and both bot kinds into the row tooltip", () => {
    const row = renderRow(
      project({ openIssues: 7, openPRs: 4, prKinds: { regular: 2, dependabot: 1, release: 1 } }),
    );
    const desc = row.getAttribute("aria-description") ?? "";
    expect(desc).toContain("repo a");
    expect(desc).toContain(m.backlog_row_tip_issues({ count: 7 }));
    expect(desc).toContain(m.backlog_row_tip_prs_code({ count: 2 }));
    expect(desc).toContain(m.prkind_dependabot_title({ count: 1 }));
    expect(desc).toContain(m.prkind_release_title({ count: 1 }));
    // the styled tip replaces the native title
    expect(row.hasAttribute("title")).toBe(false);
  });

  it("all-regular repo: no bot section in the tooltip", () => {
    const row = renderRow(
      project({ openPRs: 3, prKinds: { regular: 3, dependabot: 0, release: 0 } }),
    );
    const desc = row.getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.backlog_row_tip_prs_code({ count: 3 }));
    expect(desc).not.toContain(m.backlog_row_tip_bots_label());
  });

  it("null prKinds (Gitea fallback): the tooltip carries openPRs", () => {
    const row = renderRow(project({ kind: "gitea", openPRs: 5, prKinds: null }));
    const desc = row.getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.backlog_row_tip_prs_open({ count: 5 }));
    expect(desc).not.toContain(m.backlog_row_tip_bots_label());
  });

  it("hovering opens the tooltip; clicking selects without pinning it", async () => {
    const onselect = vi.fn();
    render(ProjectRow, {
      project: project({ openIssues: 1 }),
      pinned: false,
      selected: false,
      onselect,
      onhide: () => {},
    });
    const row = document.body.querySelector<HTMLElement>(".project-row")!;
    // A sidebar-width row outside the viewport, so no real cursor can be over it: the shared
    // browser page keeps whatever pointer position an earlier test file left, and a cursor
    // over the row would re-enter it and reopen the tip after the leave.
    row.style.cssText += "position:fixed;left:-1000px;top:120px;width:200px";
    row.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    const panel = document.querySelector<HTMLElement>(".status-tip")!;
    expect(panel.matches(":popover-open")).toBe(true);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onselect).toHaveBeenCalledTimes(1);
    row.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await expect.poll(() => panel.matches(":popover-open")).toBe(false);
  });

  it("is a compact 30px row with an 18px glyph box on a fine pointer", () => {
    const row = renderRow(project());
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(31);
    const glyph = row.querySelector<HTMLElement>(".row-glyph")!.getBoundingClientRect();
    expect(glyph.width).toBeCloseTo(18, 0);
    expect(glyph.height).toBeCloseTo(18, 0);
  });
});

describe("ProjectRow repo glyph", () => {
  afterEach(() => projectIcons.apply({}));

  it("shows the configured project emoji", () => {
    projectIcons.apply({ "/repo/a": "🐑" });
    render(ProjectRow, {
      project: project(),
      pinned: false,
      selected: false,
      onselect: () => {},
      onhide: () => {},
    });
    const glyph = document.body.querySelector(".row-glyph");
    expect(glyph?.textContent?.trim()).toBe("🐑");
    expect(glyph?.classList.contains("emoji")).toBe(true);
  });

  it("falls back to the ▣ marker when the repo has no icon", () => {
    render(ProjectRow, {
      project: project(),
      pinned: false,
      selected: false,
      onselect: () => {},
      onhide: () => {},
    });
    const glyph = document.body.querySelector(".row-glyph");
    expect(glyph?.textContent?.trim()).toBe("▣");
    expect(glyph?.classList.contains("emoji")).toBe(false);
  });
});

describe("ProjectRow keyboard", () => {
  it("Enter on the row selects it", () => {
    const onselect = vi.fn();
    render(ProjectRow, {
      project: project(),
      pinned: false,
      selected: false,
      onselect,
      onhide: () => {},
    });
    const row = document.body.querySelector<HTMLElement>(".project-row")!;
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onselect).toHaveBeenCalledTimes(1);
  });

  it("Enter on the eye button does NOT select the row (origin guard)", () => {
    const onselect = vi.fn();
    const onhide = vi.fn();
    render(ProjectRow, {
      project: project(),
      pinned: false,
      selected: false,
      onselect,
      onhide,
    });
    const eye = document.body.querySelector<HTMLElement>(".row-hide")!;
    // A keydown originating on the eye bubbles to the row's handler with a foreign
    // target; the guard must skip it so the row doesn't steal the keystroke.
    eye.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onselect).not.toHaveBeenCalled();
  });
});
