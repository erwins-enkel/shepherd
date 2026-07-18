import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import BacklogOverlay from "./BacklogOverlay.svelte";
import { backlogLayout } from "$lib/backlog-layout.svelte";
import type { BacklogPayload, BacklogProject } from "$lib/types";

const noop = () => {};

const KEY_W = "shepherd:repos-modal-w";
const KEY_H = "shepherd:repos-modal-h";
const KEY_SB = "shepherd:repos-sidebar-w";

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
  localStorage.removeItem(KEY_SB);
  backlogLayout.resetModal();
  backlogLayout.resetSidebar();
  await page.viewport(1280, 900);
});

afterEach(async () => {
  backlogLayout.resetModal();
  backlogLayout.resetSidebar();
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

    // The repo list — not the shell — absorbs overflow.
    const master = document.querySelector<HTMLElement>(".master-pane")!;
    expect(getComputedStyle(master).overflowY).toBe("auto");

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

// ── internal repository-sidebar resize + persistence ────────────────────────
describe("BacklogOverlay (Repos) sidebar resize", () => {
  it("widens the repo list on a divider drag and persists the width", async () => {
    await render(BacklogOverlay, props());
    const master = document.querySelector<HTMLElement>(".master-pane")!;
    const splitter = document.querySelector<HTMLElement>(".repo-splitter")!;
    expect(splitter).not.toBeNull();
    const before = master.getBoundingClientRect().width;

    drag(splitter, 90, 0);
    await tick();

    const after = document
      .querySelector<HTMLElement>(".master-pane")!
      .getBoundingClientRect().width;
    expect(after).toBeGreaterThan(before + 40);
    expect(backlogLayout.sidebar).not.toBeNull();
    expect(localStorage.getItem(KEY_SB)).toBe(String(backlogLayout.sidebar));
  });
});

// ── mobile ignores stored desktop sizes ─────────────────────────────────────
describe("BacklogOverlay (Repos) mobile", () => {
  it("stays full-screen and renders no resize handles despite stored sizes", async () => {
    backlogLayout.setModal(800, 600);
    backlogLayout.commitModal();
    backlogLayout.setSidebar(500);
    backlogLayout.commitSidebar();

    await render(BacklogOverlay, props({ mobile: true }));
    const card = document.querySelector<HTMLElement>(".card")!;
    expect(card.classList.contains("mobile")).toBe(true);
    expect(card.classList.contains("resized")).toBe(false);
    // Full-screen, not the stored 800px.
    expect(card.getBoundingClientRect().width).toBeCloseTo(window.innerWidth, -1);
    // No desktop resize affordances mounted.
    expect(document.querySelector(".resize-corner")).toBeNull();
    expect(document.querySelector(".repo-splitter")).toBeNull();
  });
});
