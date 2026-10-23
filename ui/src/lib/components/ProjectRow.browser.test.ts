import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import ProjectRow from "./ProjectRow.svelte";
import type { BacklogProject } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { projectIcons } from "#lib/projectIcons.svelte.js";
import { repoConfig } from "#lib/reviews.svelte.js";

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
    pinned: false,
    defaultBranch: "main",
    ...partial,
  };
}

function renderRow(p: BacklogProject) {
  render(ProjectRow, {
    project: p,
    selected: false,
    onselect: () => {},
    onhide: () => {},
    onpin: () => {},
  });
  return document.body.querySelector<HTMLElement>(".project-row")!;
}

describe("ProjectRow compact counts", () => {
  it("shows issues · code PRs with Dependabot and release notes", () => {
    const row = renderRow(
      project({ openIssues: 7, openPRs: 4, prKinds: { regular: 2, dependabot: 1, release: 1 } }),
    );
    const items = row.querySelectorAll(".count-item");
    expect(items[0]?.textContent?.trim()).toBe("7");
    const prs = row.querySelector<HTMLElement>(".count-prs")!;
    expect(prs.textContent?.trim()).toBe("2");
    expect(prs.classList.contains("prom")).toBe(true);
    const notes = [...row.querySelectorAll(".bot-note")].map((n) => n.textContent?.trim());
    expect(notes).toEqual(["+1d", "+1r"]);
  });

  it("no bot notes and a muted code count when there are no PRs", () => {
    const row = renderRow(
      project({ openPRs: 0, prKinds: { regular: 0, dependabot: 0, release: 0 } }),
    );
    const prs = row.querySelector<HTMLElement>(".count-prs")!;
    expect(prs.textContent?.trim()).toBe("0");
    expect(prs.classList.contains("prom")).toBe(false);
    expect(row.querySelectorAll(".bot-note").length).toBe(0);
  });

  it("null prKinds (Gitea fallback): shows openPRs, no bot notes", () => {
    const row = renderRow(project({ kind: "gitea", openPRs: 5, prKinds: null }));
    expect(row.querySelector(".count-prs")?.textContent?.trim()).toBe("5");
    expect(row.querySelectorAll(".bot-note").length).toBe(0);
  });

  it("shows — when the issue count is unknown", () => {
    const row = renderRow(project({ openIssues: null }));
    expect(row.querySelector(".count-item")?.textContent?.trim()).toBe("—");
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
      selected: false,
      onselect,
      onhide: () => {},
      onpin: () => {},
    });
    const row = document.body.querySelector<HTMLElement>(".project-row")!;
    // A sidebar-width row outside the viewport, so no real cursor can be over it: the shared
    // browser page keeps whatever pointer position an earlier test file left, and a cursor
    // over the row would re-enter it and reopen the tip after the leave.
    row.style.cssText += "position:fixed;left:-1000px;top:120px;width:200px";
    row.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await expect.poll(() => document.querySelector(".status-tip:popover-open")).not.toBeNull();
    const panel = document.querySelector<HTMLElement>(".status-tip")!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onselect).toHaveBeenCalledTimes(1);
    row.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await expect.poll(() => panel.matches(":popover-open")).toBe(false);
  });

  it("is a compact 30px row with a 20px repo mark on a fine pointer", () => {
    const row = renderRow(project());
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(31);
    const mark = row.querySelector<HTMLElement>(".repo-mark")!.getBoundingClientRect();
    expect(mark.width).toBeCloseTo(20, 0);
    expect(mark.height).toBeCloseTo(20, 0);
  });
});

describe("ProjectRow repo mark", () => {
  afterEach(() => projectIcons.apply({}));

  it("shows the configured project emoji", () => {
    projectIcons.apply({ "/repo/a": "🐑" });
    const row = renderRow(project());
    const mark = row.querySelector(".repo-mark");
    expect(mark?.textContent?.trim()).toBe("🐑");
    expect(mark?.classList.contains("emoji")).toBe(true);
  });

  it("falls back to the uppercase first letter of the repo name on a data tint", () => {
    const row = renderRow(project({ path: "/repo/shepherd" }));
    const mark = row.querySelector<HTMLElement>(".repo-mark")!;
    expect(mark.textContent?.trim()).toBe("S");
    expect(mark.classList.contains("emoji")).toBe(false);
    expect(mark.style.getPropertyValue("--mark")).toMatch(/^var\(--data-[1-7]\)$/);
    expect(row.textContent).not.toContain("▣");
  });
});

describe("ProjectRow pin + hide actions", () => {
  afterEach(() => {
    repoConfig.pinned = {};
  });

  const opacity = (row: HTMLElement, sel: string) =>
    getComputedStyle(row.querySelector<HTMLElement>(sel)!).opacity;

  it("shows the counts at rest, actions faded out", async () => {
    const row = renderRow(project({ openIssues: 4 }));
    // off-screen so no real cursor (shared across test files) can hover it
    row.style.cssText += "position:fixed;left:-1000px;top:120px;width:240px";
    await expect.poll(() => opacity(row, ".row-counts")).toBe("1");
    await expect.poll(() => opacity(row, ".row-actions")).toBe("0");
  });

  it("hover swaps the counts for the pin + hide actions in the same slot", async () => {
    const row = renderRow(project({ openIssues: 4 }));
    await page.elementLocator(row).hover();
    await expect.poll(() => opacity(row, ".row-actions")).toBe("1");
    await expect.poll(() => opacity(row, ".row-counts")).toBe("0");
    const counts = row.querySelector<HTMLElement>(".row-counts")!.getBoundingClientRect();
    const actions = row.querySelector<HTMLElement>(".row-actions")!.getBoundingClientRect();
    expect(Math.abs(counts.right - actions.right)).toBeLessThanOrEqual(1);
  });

  it("keyboard focus on the row reveals the actions (focus-within)", async () => {
    const row = renderRow(project());
    row.style.cssText += "position:fixed;left:-1000px;top:120px;width:240px";
    row.focus();
    await expect.poll(() => opacity(row, ".row-actions")).toBe("1");
    await expect.poll(() => opacity(row, ".row-counts")).toBe("0");
  });

  it("the pin button calls onpin, never onselect", () => {
    const onselect = vi.fn();
    const onpin = vi.fn();
    render(ProjectRow, { project: project(), selected: false, onselect, onhide: () => {}, onpin });
    const pin = document.body.querySelector<HTMLButtonElement>(".row-pin")!;
    expect(pin.getAttribute("aria-label")).toBe(m.backlog_pin_repo());
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    pin.click();
    expect(onpin).toHaveBeenCalledTimes(1);
    expect(onselect).not.toHaveBeenCalled();
  });

  it("the pin is an outline icon (stroke, no fill)", () => {
    const row = renderRow(project());
    const svg = row.querySelector(".row-pin svg")!;
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });

  it("a user-pinned repo shows the pin indicator and an Unpin action", () => {
    const row = renderRow(project({ pinned: true }));
    expect(row.querySelector(".pin-icon")?.getAttribute("aria-label")).toBe(
      m.backlog_pinned_label(),
    );
    const pin = row.querySelector<HTMLButtonElement>(".row-pin")!;
    expect(pin.getAttribute("aria-label")).toBe(m.backlog_unpin_repo());
    expect(pin.getAttribute("aria-pressed")).toBe("true");
  });

  it("the optimistic pin overlay wins over the payload baseline", () => {
    repoConfig.pinned = { "/repo/a": true };
    const row = renderRow(project({ pinned: false }));
    expect(row.querySelector(".pin-icon")).not.toBeNull();
  });

  it("a hidden row offers only unhide — no pin action or indicator", () => {
    render(ProjectRow, {
      project: project({ pinned: true }),
      hidden: true,
      selected: false,
      onselect: () => {},
      onhide: () => {},
      onpin: () => {},
    });
    expect(document.body.querySelector(".row-pin")).toBeNull();
    expect(document.body.querySelector(".pin-icon")).toBeNull();
    expect(document.body.querySelector(".row-hide")?.getAttribute("aria-label")).toBe(
      m.backlog_unhide_repo(),
    );
  });
});

describe("ProjectRow keyboard", () => {
  it("Enter on the row selects it", () => {
    const onselect = vi.fn();
    render(ProjectRow, {
      project: project(),
      selected: false,
      onselect,
      onhide: () => {},
      onpin: () => {},
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
      selected: false,
      onselect,
      onhide,
      onpin: () => {},
    });
    const eye = document.body.querySelector<HTMLElement>(".row-hide")!;
    // A keydown originating on the eye bubbles to the row's handler with a foreign
    // target; the guard must skip it so the row doesn't steal the keystroke.
    eye.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onselect).not.toHaveBeenCalled();
  });
});
