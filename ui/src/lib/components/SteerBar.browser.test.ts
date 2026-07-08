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
const api = await import("$lib/api");

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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
    await tick();
    await frames(4); // 24-chip layout takes longer to settle than the 2-frame default

    const bar = document.querySelector(".steer-bar") as HTMLElement;
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(bar.classList.contains("compact"), "bar compact on real overflow").toBe(true);
    expect(getComputedStyle(toggle).display, "ABC revealed when compact").not.toBe("none");
  });

  it("mobile, not compact (≤768px) → ABC revealed, retry-count label collapsed", async () => {
    await page.viewport(400, 900);
    // The retry chip shares `.bc-label` for its count; render it live so we can
    // assert the mobile collapse on a real element (the broadcast chip is gone).
    render(SteerBar, {
      focusedId: "s1",
      repoPath: "/repo",
      retryReady: true,
      retryHaltedCount: 1,
    });
    await tick();
    await frames();

    const bar = document.querySelector(".steer-bar") as HTMLElement;
    const toggle = document.querySelector(".lbl-toggle") as HTMLElement;
    const retryLabel = document.querySelector(".chip.retry-chip .bc-label") as HTMLElement;
    expect(bar.classList.contains("compact"), "single chip fits → not compact").toBe(false);
    expect(getComputedStyle(toggle).display, "ABC revealed by mobile rule").not.toBe("none");
    expect(getComputedStyle(retryLabel).display, "retry count collapsed on mobile").toBe("none");
  });
});

describe("SteerBar mobile Esc + dictate gating", () => {
  afterEach(async () => {
    await page.viewport(1280, 900); // restore a sane width for other suites
  });

  it("desktop (mobile:false, touch:false) → no Esc key, no dictate mic", async () => {
    await page.viewport(1000, 900);
    render(SteerBar, { focusedId: "s1", repoPath: "/repo", mobile: false, touch: false });
    await tick();
    await frames();

    expect(document.querySelector(".key.escape"), "no Esc on desktop steer bar").toBeNull();
    expect(document.querySelector(".dictate"), "no mic on desktop steer bar").toBeNull();
  });

  it("mobile → Esc key present; with micAvailable the dictate mic is present", async () => {
    await page.viewport(400, 900);
    render(SteerBar, { focusedId: "s1", repoPath: "/repo", mobile: true, micAvailable: true });
    await tick();
    await frames();

    expect(document.querySelector(".key.escape"), "Esc present on mobile").not.toBeNull();
    expect(document.querySelector(".dictate"), "mic present when available").not.toBeNull();
  });

  it("mobile without micAvailable → Esc present but no dictate mic", async () => {
    await page.viewport(400, 900);
    render(SteerBar, { focusedId: "s1", repoPath: "/repo", mobile: true, micAvailable: false });
    await tick();
    await frames();

    expect(document.querySelector(".key.escape"), "Esc present on mobile").not.toBeNull();
    expect(document.querySelector(".dictate"), "no mic when unavailable").toBeNull();
  });

  it("mobile dictate mic fires ondictate on pointerdown", async () => {
    await page.viewport(400, 900);
    const ondictate = vi.fn();
    render(SteerBar, {
      focusedId: "s1",
      repoPath: "/repo",
      mobile: true,
      micAvailable: true,
      ondictate,
    });
    await tick();
    await frames();

    const mic = document.querySelector(".dictate") as HTMLElement;
    mic.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    await tick();

    expect(ondictate).toHaveBeenCalledOnce();
  });
});

describe("SteerBar edit-steers button", () => {
  afterEach(async () => {
    await page.viewport(1280, 900); // restore a sane width for other suites
  });

  it("renders the pencil edit button, outside the measured bar, with an accessible name", async () => {
    await page.viewport(1000, 900);
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo", onedit });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
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
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
    await tick();
    await frames(4); // 24-chip layout takes longer to settle than the 2-frame default

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    const abc = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(getComputedStyle(editBtn).display, "edit hidden when compact").toBe("none");
    expect(getComputedStyle(abc).display, "ABC revealed when compact").not.toBe("none");
  });

  it("mobile (≤768px) → edit hidden, ABC shown", async () => {
    await page.viewport(400, 900);
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
    await tick();
    await frames();

    const editBtn = document.querySelector(".edit-steers") as HTMLElement;
    const abc = document.querySelector(".lbl-toggle") as HTMLElement;
    expect(getComputedStyle(editBtn).display, "edit hidden on mobile").toBe("none");
    expect(getComputedStyle(abc).display, "ABC revealed by mobile rule").not.toBe("none");
  });
});

describe("SteerBar steer context menu", () => {
  beforeEach(() => {
    vi.mocked(api.replySession).mockClear();
  });

  // The steer chip carries an emoji, so `.chip.has-emoji` uniquely targets it.
  const steerChip = () => document.querySelector(".steer-bar .chip.has-emoji") as HTMLElement;

  it("right-clicking a chip opens a menu with Run and Edit, and does not send", async () => {
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
    await tick();

    steerChip().dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
    );
    await tick();

    const menu = document.querySelector(".steer-menu") as HTMLElement;
    expect(menu, "context menu opened").not.toBeNull();
    const items = menu.querySelectorAll(".sm-item");
    expect(items.length).toBe(2);
    expect(menu.getAttribute("role")).toBe("menu");
    // The right-click itself must never fire the steer (the menu is the deliberate path).
    expect(api.replySession).not.toHaveBeenCalled();
  });

  it("Run sends the steer to the focused session", async () => {
    render(SteerBar, { focusedId: "s1", repoPath: "/repo" });
    await tick();

    steerChip().dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
    );
    await tick();

    const runItem = document.querySelectorAll(".steer-menu .sm-item")[0] as HTMLElement;
    runItem.click();
    await tick();

    expect(api.replySession).toHaveBeenCalledWith("s1", "ship it");
    expect(document.querySelector(".steer-menu"), "menu closes after Run").toBeNull();
  });

  it("Edit fires onedit with the steer id and does not send", async () => {
    const onedit = vi.fn();
    render(SteerBar, { focusedId: "s1", repoPath: "/repo", onedit });
    await tick();

    steerChip().dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
    );
    await tick();

    const editItem = document.querySelectorAll(".steer-menu .sm-item")[1] as HTMLElement;
    editItem.click();
    await tick();

    expect(onedit).toHaveBeenCalledWith("1");
    expect(api.replySession).not.toHaveBeenCalled();
    expect(document.querySelector(".steer-menu"), "menu closes after Edit").toBeNull();
  });
});
