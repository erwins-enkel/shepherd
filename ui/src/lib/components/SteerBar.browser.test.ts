import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { tick } from "svelte";
import "../../app.css";
import type { Steer } from "$lib/types";

// Mock api so the steer-send path never fires a real network call.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, replySession: vi.fn(async () => undefined) };
});

const { default: SteerBar } = await import("./SteerBar.svelte");
const { steers } = await import("$lib/steers.svelte");

const LABELS_KEY = "shepherd:steer-labels";
const COACH_KEY = "shepherd:steer-coach-seen";

const steer = (p: Partial<Steer>): Steer => ({
  id: "1",
  label: "Ship",
  text: "ship it",
  emoji: "🚀",
  inSteerBar: true,
  onIssues: false,
  ...p,
});

beforeEach(() => {
  localStorage.setItem(COACH_KEY, "1"); // suppress the one-time coach hint
  localStorage.removeItem(LABELS_KEY);
  steers.list = [steer({ id: "1", label: "Ship", emoji: "🚀" })];
});

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("SteerBar labels toggle", () => {
  it("renders a right-anchored ABC toggle, off by default", () => {
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(toggle, "ABC toggle rendered").not.toBeNull();
    expect(toggle.textContent?.trim()).toBe("ABC");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // WCAG 2.5.3 label-in-name: the visible "ABC" glyph must be in the accessible name.
    expect(toggle.getAttribute("aria-label")).toContain("ABC");
    // Toggle lives OUTSIDE the measured/scrolling .steer-bar so it can't poison fitLabels.
    expect(document.querySelector(".steer-bar")!.contains(toggle)).toBe(false);
    expect(document.querySelector(".steer-bar")!.classList.contains("show-labels")).toBe(false);
  });

  it("clicking the toggle reveals labels, persists, and flips aria-pressed", async () => {
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;

    toggle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    toggle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await tick();

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".steer-bar")!.classList.contains("show-labels")).toBe(true);
    expect(localStorage.getItem(LABELS_KEY)).toBe("1");
  });

  it("starts in the labels-on state when persisted", () => {
    localStorage.setItem(LABELS_KEY, "1");
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".steer-bar")!.classList.contains("show-labels")).toBe(true);
  });
});

// fitLabels measures via rAF + ResizeObserver; let layout settle before reading style.
const frames = (n = 2) =>
  new Promise<void>((r) => {
    let i = 0;
    const step = () => (++i >= n ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

describe("ABC visibility gating", () => {
  afterEach(async () => {
    await page.viewport(1280, 900); // restore a sane width for other suites
  });

  it("desktop, not compact (everything fits) → ABC hidden", async () => {
    await page.viewport(1000, 900);
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames();

    const bar = document.querySelector(".steer-bar") as HTMLElement;
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(bar.classList.contains("compact"), "bar not compact when one chip fits").toBe(false);
    expect(getComputedStyle(toggle).display, "ABC hidden on wide non-compact bar").toBe("none");
  });

  it("compact via real overflow (>768px) → ABC revealed by compact alone", async () => {
    await page.viewport(800, 900);
    // Many emoji chips with long labels so full labels overflow ~800px and fitLabels
    // sets AND keeps `compact` (real overflow is stable because fitLabels owns the class;
    // a hand-added one would be stripped on the next ResizeObserver/MutationObserver
    // decide() since the cached fullWidth wouldn't justify it).
    steers.list = Array.from({ length: 24 }, (_, i) =>
      steer({
        id: String(i + 1),
        label: `Long Steering Label Number ${i + 1}`,
        emoji: "🚀",
      }),
    );
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames(4); // 24-chip layout takes longer to settle than the 2-frame default

    const bar = document.querySelector(".steer-bar") as HTMLElement;
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(bar.classList.contains("compact"), "bar compact on real overflow").toBe(true);
    expect(getComputedStyle(toggle).display, "ABC revealed when compact").not.toBe("none");
  });

  it("mobile, not compact (≤768px) → ABC revealed, ⌁ label collapsed", async () => {
    await page.viewport(400, 900);
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames();

    const bar = document.querySelector(".steer-bar") as HTMLElement;
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    const bcLabel = document.querySelector(".chip.bc .bc-label") as HTMLElement;
    expect(bar.classList.contains("compact"), "single chip fits → not compact").toBe(false);
    expect(getComputedStyle(toggle).display, "ABC revealed by mobile rule").not.toBe("none");
    expect(getComputedStyle(bcLabel).display, "⌁ label collapsed on mobile").toBe("none");
  });
});

describe("SteerBar edit-steers button", () => {
  afterEach(async () => {
    await page.viewport(1280, 900); // restore a sane width for other suites
  });

  it("renders the pencil edit button, outside the measured bar, with an accessible name", async () => {
    await page.viewport(1000, 900);
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames();

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    expect(editBtn, "edit-steers button rendered").not.toBeNull();
    expect(editBtn.textContent).toContain("✎");
    expect(editBtn.getAttribute("title")?.trim()).toBeTruthy();
    expect(editBtn.getAttribute("aria-label")?.trim()).toBeTruthy();
    expect(editBtn.getAttribute("title")).toBe(editBtn.getAttribute("aria-label"));
    // Lives OUTSIDE the measured/scrolling .steer-bar so it can't poison fitLabels.
    expect(document.querySelector(".steer-bar")!.contains(editBtn)).toBe(false);
  });

  it("clicking it fires onedit", async () => {
    await page.viewport(1000, 900);
    const onedit = vi.fn();
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {}, onedit });
    await tick();
    await frames();

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    editBtn.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    editBtn.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await tick();

    expect(onedit).toHaveBeenCalledOnce();
  });

  it("desktop fits → edit shown, ABC hidden", async () => {
    await page.viewport(1000, 900);
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames();

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    const abc = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(getComputedStyle(editBtn).display, "edit shown on wide non-compact bar").not.toBe(
      "none",
    );
    expect(getComputedStyle(abc).display, "ABC hidden on wide non-compact bar").toBe("none");
  });

  it("compact overflow (>768px) → edit hidden, ABC shown", async () => {
    await page.viewport(800, 900);
    steers.list = Array.from({ length: 24 }, (_, i) =>
      steer({
        id: String(i + 1),
        label: `Long Steering Label Number ${i + 1}`,
        emoji: "🚀",
      }),
    );
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames(4); // 24-chip layout takes longer to settle than the 2-frame default

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    const abc = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(getComputedStyle(editBtn).display, "edit hidden when compact").toBe("none");
    expect(getComputedStyle(abc).display, "ABC revealed when compact").not.toBe("none");
  });

  it("mobile (≤768px) → edit hidden, ABC shown", async () => {
    await page.viewport(400, 900);
    render(SteerBar, { focusedId: "s1", onbroadcast: () => {} });
    await tick();
    await frames();

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    const abc = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(getComputedStyle(editBtn).display, "edit hidden on mobile").toBe("none");
    expect(getComputedStyle(abc).display, "ABC revealed by mobile rule").not.toBe("none");
  });
});
