import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import BacklogOverlay from "./BacklogOverlay.svelte";
import { m } from "#lib/paraglide/messages.js";
import { backlogLayout } from "#lib/backlog-layout.svelte.js";
import type { BacklogPayload, BacklogProject } from "#lib/types.js";

const noop = () => {};

const KEY_W = "shepherd:repos-modal-w";
const KEY_H = "shepherd:repos-modal-h";

function project(path: string): BacklogProject {
  return {
    path,
    display: path,
    slug: `org/${path}`,
    kind: "github",
    openIssues: 3,
    openPRs: 1,
    prKinds: null,
    workflows: null,
    ciStatus: null,
    hidden: false,
  };
}

// n projects → the master list wants to be n·rows tall; the fixed shell height
// keeps busy vs sparse payloads from resizing the shell (the list scrolls inside).
function payload(n: number): BacklogPayload {
  return {
    pinnedPath: null,
    projects: Array.from({ length: n }, (_, i) => project(`/r/repo-${i}`)),
    totals: { openIssues: 0, openPRs: 0 },
  };
}

function props(over: Partial<Record<string, unknown>> = {}) {
  return {
    payload: payload(40),
    mobile: false,
    onissue: noop,
    onpr: noop,
    onadopt: noop,
    onlaunchtrain: noop,
    onclose: noop,
    onaddclone: noop,
    onaddfork: noop,
    onaddnewproject: noop,
    ...over,
  };
}

function pointer(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      isPrimary: true,
    }),
  );
}

/** Drag `el` by (dx,dy) from its current center via synthetic pointer events. */
function drag(el: Element, dx: number, dy: number) {
  const r = el.getBoundingClientRect();
  const sx = r.left + r.width / 2;
  const sy = r.top + r.height / 2;
  pointer(el, "pointerdown", sx, sy);
  pointer(el, "pointermove", sx + dx, sy + dy);
  pointer(el, "pointerup", sx + dx, sy + dy);
}

beforeEach(async () => {
  localStorage.removeItem(KEY_W);
  localStorage.removeItem(KEY_H);
  backlogLayout.resetModal();
  await page.viewport(1280, 900);
});

afterEach(async () => {
  backlogLayout.resetModal();
  await page.viewport(1280, 900);
});

// ── default geometry + stability ────────────────────────────────────────────
describe("BacklogOverlay (Repos) default geometry", () => {
  it("opens at ~90vw × 88vh (no more 960px cap)", async () => {
    await render(BacklogOverlay, props());
    const card = document.querySelector<HTMLElement>(".card")!;
    expect(card.classList.contains("mobile")).toBe(false);
    const rect = card.getBoundingClientRect();
    expect(rect.width).toBeCloseTo(0.9 * window.innerWidth, -1);
    expect(rect.height).toBeCloseTo(0.88 * window.innerHeight, -1);
    // Substantially wider than the old 960px cap.
    expect(rect.width).toBeGreaterThan(1000);
  });

  it("keeps the shell geometry stable across content changes", async () => {
    const { rerender } = await render(BacklogOverlay, props({ payload: payload(40) }));
    const card = document.querySelector<HTMLElement>(".card")!;
    const before = card.getBoundingClientRect();

    // The repo list — not the shell — absorbs overflow: it scrolls inside the
    // switcher popover, whatever the repo count.
    await openSwitcher();
    const list = document.querySelector<HTMLElement>(".rs-scroll")!;
    expect(getComputedStyle(list).overflowY).toBe("auto");
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

    await rerender(props({ payload: payload(2) }));
    const after = document.querySelector<HTMLElement>(".card")!.getBoundingClientRect();
    expect(after.height).toBeCloseTo(before.height, 0);
    expect(after.top).toBeCloseTo(before.top, 0);
  });
});

// ── outer modal resize + persistence ────────────────────────────────────────
describe("BacklogOverlay (Repos) modal resize", () => {
  it("shrinks the shell on a corner drag and persists the size", async () => {
    await render(BacklogOverlay, props());
    const card = document.querySelector<HTMLElement>(".card")!;
    const before = card.getBoundingClientRect();
    const handle = document.querySelector<HTMLElement>(".resize-corner")!;
    expect(handle).not.toBeNull();

    // Drag the bottom-right corner up-left to shrink (stays clear of clamps).
    drag(handle, -140, -100);
    await tick();

    const after = card.getBoundingClientRect();
    expect(after.width).toBeLessThan(before.width - 50);
    expect(after.height).toBeLessThan(before.height - 30);
    // Committed to localStorage + the store.
    expect(backlogLayout.width).not.toBeNull();
    expect(localStorage.getItem(KEY_W)).toBe(String(backlogLayout.width));
    expect(localStorage.getItem(KEY_H)).toBe(String(backlogLayout.height));
  });

  it("keeps the corner under the pointer (2× delta compensates for centering)", async () => {
    await render(BacklogOverlay, props());
    const card = document.querySelector<HTMLElement>(".card")!;
    const handle = document.querySelector<HTMLElement>(".resize-corner")!;
    const before = card.getBoundingClientRect();

    // Shrink by (dx,dy): the bottom-right edge must follow the pointer 1:1, i.e.
    // move by (dx,dy) — a 1× delta bug would move it only half as far.
    const dx = -140;
    const dy = -100;
    drag(handle, dx, dy);
    await tick();

    const after = card.getBoundingClientRect();
    expect(after.right - before.right).toBeCloseTo(dx, -1);
    expect(after.bottom - before.bottom).toBeCloseTo(dy, -1);
  });

  it("clamps an oversized stored size to the viewport (measured geometry)", async () => {
    // Seed a size far larger than the viewport, then render smaller.
    backlogLayout.setModal(4000, 4000);
    backlogLayout.commitModal();
    await page.viewport(1100, 780);

    await render(BacklogOverlay, props());
    const rect = document.querySelector<HTMLElement>(".card")!.getBoundingClientRect();
    // CSS ceiling = calc(100vw/vh − 48px); measured geometry must respect it.
    expect(rect.width).toBeLessThanOrEqual(window.innerWidth - 48 + 1);
    expect(rect.height).toBeLessThanOrEqual(window.innerHeight - 48 + 1);
  });
});

// ── the repo sidebar is gone: the header switcher replaces it ───────────────
describe("BacklogOverlay (Repos) header switcher replaces the sidebar", () => {
  it("renders no sidebar or splitter; the detail column spans the whole card", async () => {
    await render(BacklogOverlay, props({ filterPaths: ["/r/repo-0"] }));
    expect(document.querySelector(".master-pane")).toBeNull();
    expect(document.querySelector(".repo-splitter")).toBeNull();
    expect(document.querySelector(".chead")).toBeNull();
    const card = document.querySelector<HTMLElement>(".card")!.getBoundingClientRect();
    const detail = document.querySelector<HTMLElement>(".detail-column")!.getBoundingClientRect();
    expect(detail.width).toBeCloseTo(card.width - 2, 0); // card border
  });

  it("never reads or writes the old sidebar width key", async () => {
    localStorage.setItem("shepherd:repos-sidebar-w", "400");
    await render(BacklogOverlay, props());
    await openSwitcher();
    expect(document.querySelector(".master-pane")).toBeNull();
    expect(localStorage.getItem("shepherd:repos-sidebar-w")).toBe("400");
    localStorage.removeItem("shepherd:repos-sidebar-w");
  });
});

// ── mobile ignores stored desktop sizes ─────────────────────────────────────
describe("BacklogOverlay (Repos) mobile", () => {
  it("stays full-screen and renders no resize handles despite stored sizes", async () => {
    backlogLayout.setModal(800, 600);
    backlogLayout.commitModal();

    await render(BacklogOverlay, props({ mobile: true }));
    const card = document.querySelector<HTMLElement>(".card")!;
    expect(card.classList.contains("mobile")).toBe(true);
    expect(card.classList.contains("resized")).toBe(false);
    // Full-screen, not the stored 800px.
    expect(card.getBoundingClientRect().width).toBeCloseTo(window.innerWidth, -1);
    // No desktop resize affordances mounted.
    expect(document.querySelector(".resize-corner")).toBeNull();
    expect(document.querySelector(".repo-splitter")).toBeNull();
    // Mobile keeps the title bar and the inline list; no desktop switcher header.
    expect(document.querySelector(".chead")).not.toBeNull();
    expect(document.querySelector(".rs-trigger")).toBeNull();
    expect(document.querySelector(".project-row")).not.toBeNull();
  });
});

// ── active filter chip picks the opened tab ─────────────────────────────────
// The rule itself (which chip wins) is unit-tested in backlog-view.test.ts via
// tabForFilters. These mount the real BacklogView to prove the WIRING: that the
// helper is applied at every place a repo gets selected — the desktop list, the
// mobile list, and the dashboard-filter entry.

/** Tab buttons in their fixed BacklogTabBar order, scoped to one variant's bar. */
function tabs(scope: ".tab-bar" | ".overlay-tabs") {
  const btns = [...document.querySelectorAll<HTMLButtonElement>(`${scope} .tab-btn`)];
  return { issues: btns[0], prs: btns[1], actions: btns[2] };
}

/** Open the desktop switcher popover (header trigger) and wait until it is up. */
async function openSwitcher() {
  const trigger = document.querySelector<HTMLButtonElement>(".rs-trigger");
  expect(trigger, "no switcher trigger").toBeTruthy();
  if (!document.querySelector(".rs-pop")) {
    trigger!.click();
    await tick();
    await vi.waitFor(() => expect(document.querySelector(".rs-pop:popover-open")).not.toBeNull());
  }
}

/** The repo-filter checkbox carrying `label`, behind the filter icon (opened first).
 *  On desktop the filter lives in the switcher popover, which is opened first. */
async function chip(label: string): Promise<HTMLInputElement> {
  if (document.querySelector(".rs-trigger")) await openSwitcher();
  const trigger = document.querySelector<HTMLButtonElement>(".repo-filter-trigger");
  expect(trigger, "no repo filter trigger").toBeTruthy();
  if (trigger!.getAttribute("aria-expanded") !== "true") trigger!.click();
  const found = [...document.querySelectorAll<HTMLLabelElement>(".filter-popover .filter-row")]
    .find((r) => r.textContent?.includes(label))
    ?.querySelector<HTMLInputElement>("input[type=checkbox]");
  expect(found, `no repo filter labelled ${label}`).toBeTruthy();
  return found!;
}

/** A repo row by its visible name (ProjectRow shows the path basename). Desktop rows
 *  only exist while the switcher popover is open. */
async function row(name: string): Promise<HTMLElement> {
  if (document.querySelector(".rs-trigger")) await openSwitcher();
  const found = [...document.querySelectorAll<HTMLElement>(".project-row")].find(
    (r) => r.querySelector(".row-name")?.textContent?.trim() === name,
  );
  expect(found, `no repo row named ${name}`).toBeTruthy();
  return found!;
}

async function click(el: HTMLElement) {
  el.click();
  await tick();
}

describe("BacklogOverlay (Repos) filter chip → opened tab", () => {
  it("desktop: has-PRs on, clicking a repo opens the PRs tab", async () => {
    await render(BacklogOverlay, props());
    await click(await chip(m.backlog_filter_has_prs()));
    await click(await row("repo-0"));

    const t = tabs(".tab-bar");
    expect(t.prs.classList.contains("active")).toBe(true);
    expect(t.issues.classList.contains("active")).toBe(false);
  });

  it("mobile: has-PRs on, tapping a repo opens the detail overlay on the PRs tab", async () => {
    await render(BacklogOverlay, props({ mobile: true }));
    await click(await chip(m.backlog_filter_has_prs()));
    await click(await row("repo-0"));

    // The mobile tab bar lives INSIDE the detail overlay, so its very presence
    // means the row click reached the mobile branch's handler.
    expect(document.querySelector(".mobile-detail-overlay")).not.toBeNull();
    const t = tabs(".overlay-tabs");
    expect(t.prs.classList.contains("active")).toBe(true);
    expect(t.issues.classList.contains("active")).toBe(false);
  });

  it("has-issues on wins over has-PRs and pulls a PRs-tab reader back to Issues", async () => {
    await render(BacklogOverlay, props({ filterPaths: ["/r/repo-0"] }));
    await click(tabs(".tab-bar").prs);
    await click(await chip(m.backlog_filter_has_prs()));
    await click(await chip(m.backlog_filter_has_issues()));
    await click(await row("repo-0"));

    const t = tabs(".tab-bar");
    expect(t.issues.classList.contains("active")).toBe(true);
    expect(t.prs.classList.contains("active")).toBe(false);
  });

  it("no chip active: selecting a repo leaves the current tab alone", async () => {
    await render(BacklogOverlay, props({ filterPaths: ["/r/repo-0"] }));
    await click(tabs(".tab-bar").prs);
    await click(await row("repo-0"));

    // A `null` return must mean "leave alone", not "fall back to issues".
    const t = tabs(".tab-bar");
    expect(t.prs.classList.contains("active")).toBe(true);
    expect(t.issues.classList.contains("active")).toBe(false);
  });
});

// ── how the dialog is entered ───────────────────────────────────────────────
// A FRESH object every call: a poll delivers a new payload identity.
function seedPayload(): BacklogPayload {
  return {
    pinnedPath: "/r/pinned",
    projects: [project("/r/pinned"), { ...project("/r/nopr"), openPRs: 0 }, project("/r/third")],
    totals: { openIssues: 0, openPRs: 0 },
  };
}

/** The repo named on the switcher trigger (the open repo), or the "Choose repo" prompt. */
function triggerName(): string | null {
  return document.querySelector(".rs-trigger .rs-name")?.textContent?.trim() ?? null;
}

const gridNames = () =>
  [...document.querySelectorAll(".rg-tile .rg-name")].map((n) => n.textContent?.trim()).sort();

describe("BacklogOverlay (Repos) entry", () => {
  it("no filter: nothing is preselected — not even the pinned repo — and the grid shows", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload() }));
    expect(triggerName()).toBe(m.repos_switcher_choose());
    expect(document.querySelector(".rg")).not.toBeNull();
    expect(document.querySelector(".tab-bar")).toBeNull();
    expect(document.querySelector(".rh-badge")).toBeNull();
    expect(document.querySelector(".rh-recent")).toBeNull(); // the grid's recents are the same shortcut
    expect(gridNames()).toEqual(["nopr", "pinned", "third"]);
    // The grid spans the whole card; the search has the cursor.
    const card = document.querySelector<HTMLElement>(".card")!.getBoundingClientRect();
    const grid = document.querySelector<HTMLElement>(".rg")!.getBoundingClientRect();
    expect(grid.width).toBeCloseTo(card.width - 2, 0);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector(".rg-search")),
    );
  });

  it("picking a tile opens that repo and drops the grid", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload() }));
    await click(
      [...document.querySelectorAll<HTMLElement>(".rg-tile")].find((t) =>
        t.textContent?.includes("nopr"),
      )!,
    );
    expect(triggerName()).toBe("nopr");
    expect(document.querySelector(".rg")).toBeNull();
    expect(document.querySelector(".tab-bar")).not.toBeNull();
  });

  it("one filtered repo: opens in it, switcher closed, with the dashboard-filter badge", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload(), filterPaths: ["/r/nopr"] }));
    expect(triggerName()).toBe("nopr");
    expect(document.querySelector(".rs-pop")).toBeNull();
    expect(document.querySelector(".rg")).toBeNull();
    expect(document.querySelector(".rh-badge")?.textContent).toBe(m.repos_head_from_filter());
    expect(tabs(".tab-bar").issues.classList.contains("active")).toBe(true);
  });

  it("the badge goes away once another repo is picked — even coming back to the filtered one", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload(), filterPaths: ["/r/nopr"] }));
    await click(await row("pinned"));
    expect(triggerName()).toBe("pinned");
    expect(document.querySelector(".rh-badge")).toBeNull();
    await click(await row("nopr"));
    expect(document.querySelector(".rh-badge")).toBeNull();
  });

  it("a dashboard-filter change after opening does not move the open repo", async () => {
    const { rerender } = await render(
      BacklogOverlay,
      props({ payload: seedPayload(), filterPaths: ["/r/nopr"] }),
    );
    await click(await row("pinned"));
    await rerender(props({ payload: seedPayload(), filterPaths: ["/r/third"] }));
    await tick();
    expect(triggerName()).toBe("pinned");
  });

  it("several filtered repos: no preselection, the grid shows only those", async () => {
    await render(
      BacklogOverlay,
      props({ payload: seedPayload(), filterPaths: ["/r/pinned", "/r/third"] }),
    );
    expect(triggerName()).toBe(m.repos_switcher_choose());
    expect(gridNames()).toEqual(["pinned", "third"]);
    expect(document.querySelector(".rg-badge")?.textContent).toBe(
      m.repos_grid_filtered({ count: 2 }),
    );
  });

  it("filtered repos missing from the backlog fall back to the whole grid", async () => {
    await render(
      BacklogOverlay,
      props({ payload: seedPayload(), filterPaths: ["/gone/a", "/gone/b"] }),
    );
    expect(gridNames()).toEqual(["nopr", "pinned", "third"]);
    expect(document.querySelector(".rg-badge")).toBeNull();
  });

  it("an explicit selectPath (command bar / repo added) beats the dashboard filter", async () => {
    await render(
      BacklogOverlay,
      props({ payload: seedPayload(), filterPaths: ["/r/nopr"], selectPath: "/r/third" }),
    );
    expect(triggerName()).toBe("third");
    expect(document.querySelector(".rh-badge")).toBeNull();
  });

  it("an EPIC-badge target opens its repo directly, beating the dashboard filter", async () => {
    // `target` is also a render() option name, so the props go under `props`.
    await render(BacklogOverlay, {
      props: props({
        payload: seedPayload(),
        filterPaths: ["/r/nopr"],
        target: { repoPath: "/r/third", issueNumber: 7 },
      }),
    });
    expect(triggerName()).toBe("third");
    expect(document.querySelector(".rh-badge")).toBeNull();
    expect(document.querySelector(".rg")).toBeNull();
  });

  it("a repo that vanishes from the payload drops the open repo back to the grid", async () => {
    const { rerender } = await render(
      BacklogOverlay,
      props({ payload: seedPayload(), filterPaths: ["/r/nopr"] }),
    );
    const p = seedPayload();
    await rerender(
      props({ payload: { ...p, projects: p.projects.filter((x) => x.path !== "/r/nopr") } }),
    );
    await tick();
    expect(triggerName()).toBe(m.repos_switcher_choose());
    expect(document.querySelector(".rg")).not.toBeNull();
  });

  it("a poll does not re-tab or re-select a repo that is being read", async () => {
    const { rerender } = await render(
      BacklogOverlay,
      props({ payload: seedPayload(), filterPaths: ["/r/pinned"] }),
    );
    await click(tabs(".tab-bar").actions);
    await rerender(props({ payload: seedPayload(), filterPaths: ["/r/pinned"] }));
    await tick();
    expect(triggerName()).toBe("pinned");
    expect(tabs(".tab-bar").actions.classList.contains("active")).toBe(true);
  });

  it("Esc in the grid search clears the text first, then closes the dialog", async () => {
    const onclose = vi.fn();
    await render(BacklogOverlay, props({ payload: seedPayload(), onclose }));
    const search = document.querySelector<HTMLInputElement>(".rg-search")!;
    search.value = "third";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await tick();
    expect(search.value).toBe("");
    expect(onclose).not.toHaveBeenCalled();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("↵ in the grid search opens the top match", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload() }));
    const search = document.querySelector<HTMLInputElement>(".rg-search")!;
    search.value = "third";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await tick();
    expect(triggerName()).toBe("third");
  });

  it("mobile: no grid; one filtered repo still opens its detail, no badge", async () => {
    await render(
      BacklogOverlay,
      props({ mobile: true, payload: seedPayload(), filterPaths: ["/r/nopr"] }),
    );
    expect(document.querySelector(".rg")).toBeNull();
    expect(document.querySelector(".rh-badge")).toBeNull();
    expect(document.querySelector(".mobile-detail-overlay")).not.toBeNull();
  });

  it("mobile: no filter shows the list, not the grid", async () => {
    await render(BacklogOverlay, props({ mobile: true, payload: seedPayload() }));
    expect(document.querySelector(".rg")).toBeNull();
    expect(document.querySelector(".project-row")).not.toBeNull();
    expect(document.querySelector(".mobile-detail-overlay")).toBeNull();
  });
});

// ── the scope is popover-local: it never deselects the open repo ────────────
describe("BacklogOverlay (Repos) filter scope vs the open repo", () => {
  it("turning has-PRs on keeps a no-PR repo open", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload() }));
    await click(await row("nopr"));
    expect(triggerName()).toBe("nopr");

    await click(await chip(m.backlog_filter_has_prs()));
    // nopr left the (scoped) list, but the detail pane still shows it.
    expect(triggerName()).toBe("nopr");
    expect(document.querySelector(".detail-empty")).toBeNull();
    expect(document.querySelector(".tab-bar")).not.toBeNull();
  });

  it("typing in the switcher search keeps the open repo", async () => {
    await render(BacklogOverlay, props({ payload: seedPayload(), filterPaths: ["/r/pinned"] }));
    await openSwitcher();
    const search = document.querySelector<HTMLInputElement>(".filter-search")!;
    search.value = "zzz-no-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(triggerName()).toBe("pinned");
    expect(document.querySelector(".detail-empty")).toBeNull();
  });
});
