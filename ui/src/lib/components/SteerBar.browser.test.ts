import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
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
