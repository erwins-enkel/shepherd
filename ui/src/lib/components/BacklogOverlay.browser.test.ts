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
    await render(BacklogOverlay, props());
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
// mobile list, and the desktop pinned-repo auto-seed.

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
    await render(BacklogOverlay, props());
    await click(tabs(".tab-bar").prs);
    await click(await chip(m.backlog_filter_has_prs()));
    await click(await chip(m.backlog_filter_has_issues()));
    await click(await row("repo-0"));

    const t = tabs(".tab-bar");
    expect(t.issues.classList.contains("active")).toBe(true);
    expect(t.prs.classList.contains("active")).toBe(false);
  });

  it("no chip active: selecting a repo leaves the current tab alone", async () => {
    await render(BacklogOverlay, props());
    await click(tabs(".tab-bar").prs);
    await click(await row("repo-0"));

    // A `null` return must mean "leave alone", not "fall back to issues".
    const t = tabs(".tab-bar");
    expect(t.prs.classList.contains("active")).toBe(true);
    expect(t.issues.classList.contains("active")).toBe(false);
  });
});

// ── pinned-repo auto-seed honours the chip ──────────────────────────────────
// A FRESH object every call: the seed $effect tracks the `payload` prop, so only
// a new identity re-fires it (which is what a real poll delivers).
function seedPayload(): BacklogPayload {
  return {
    pinnedPath: "/r/pinned",
    projects: [project("/r/pinned"), { ...project("/r/nopr"), openPRs: 0 }],
    totals: { openIssues: 0, openPRs: 0 },
  };
}

/** Pinned repo named but absent from the list → nothing to seed. */
function unseededPayload(): BacklogPayload {
  const p = seedPayload();
  return { ...p, projects: p.projects.filter((x) => x.path !== "/r/pinned") };
}

/** The repo named on the switcher trigger (the open repo), or null when none. */
function triggerName(): string | null {
  return document.querySelector(".rs-trigger .rs-name")?.textContent?.trim() ?? null;
}

describe("BacklogOverlay (Repos) pinned auto-seed vs filter chip", () => {
  it("a seed that fires while has-PRs is on lands on the PRs tab", async () => {
    const { rerender } = await render(BacklogOverlay, props({ payload: unseededPayload() }));
    // Nothing to seed yet: the detail pane is empty.
    expect(document.querySelector(".detail-empty")).not.toBeNull();
    await click(await chip(m.backlog_filter_has_prs()));

    // A poll delivers the pinned repo → the seed fires and reads the chip.
    await rerender(props({ payload: seedPayload() }));
    await tick();

    expect(triggerName()).toBe("pinned");
    const t = tabs(".tab-bar");
    expect(t.prs.classList.contains("active")).toBe(true);
    expect(t.issues.classList.contains("active")).toBe(false);
  });

  it("a poll does not re-tab a still-live selection", async () => {
    const { rerender } = await render(BacklogOverlay, props({ payload: seedPayload() }));
    // Mount seeds the pinned repo with no chip active → Issues, as today.
    expect(triggerName()).toBe("pinned");
    // Park on Actions, then filter — the selection survives and so does the tab.
    await click(tabs(".tab-bar").actions);
    await click(await chip(m.backlog_filter_has_prs()));
    expect(triggerName()).toBe("pinned");

    await rerender(props({ payload: seedPayload() }));
    await tick();

    // The seed's `selectedPath === null` guard held: no tab was rewritten.
    const t = tabs(".tab-bar");
    expect(t.actions.classList.contains("active")).toBe(true);
    expect(t.prs.classList.contains("active")).toBe(false);
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
    await render(BacklogOverlay, props({ payload: seedPayload() }));
    await openSwitcher();
    const search = document.querySelector<HTMLInputElement>(".filter-search")!;
    search.value = "zzz-no-match";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(triggerName()).toBe("pinned");
    expect(document.querySelector(".detail-empty")).toBeNull();
  });
});
