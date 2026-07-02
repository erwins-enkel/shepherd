import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { createTabSignal } from "./tab-signal.svelte";

// Exercises the side-effecting controller against a real DOM (real <link>, real
// canvas, real document.title) — the part deriveTabState's unit tests can't cover.

let link: HTMLLinkElement;
let setBadge: ReturnType<typeof vi.fn>;
let clearBadge: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  document.title = "Shepherd";
  document.querySelectorAll('link[rel="icon"]').forEach((n) => n.remove());
  link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = "/favicon.svg";
  document.head.appendChild(link);
  setBadge = vi.fn(() => Promise.resolve());
  clearBadge = vi.fn(() => Promise.resolve());
  (navigator as unknown as { setAppBadge: unknown }).setAppBadge = setBadge;
  (navigator as unknown as { clearAppBadge: unknown }).clearAppBadge = clearBadge;
});

afterEach(() => {
  vi.useRealTimers();
  link.remove();
});

const flush = () => vi.advanceTimersByTime(400); // past the debounce

test("background tier: title count, PNG favicon swap, App Badge set", () => {
  const signal = createTabSignal();
  signal.update({ count: 3, severity: "amber", attended: false });
  flush();

  expect(document.title).toBe("(3) Shepherd");
  expect(link.type).toBe("image/png");
  expect(link.href.startsWith("data:image/png")).toBe(true);
  expect(setBadge).toHaveBeenLastCalledWith(3);
  expect(signal.announcement).toContain("3");
});

test("attended tier: suppresses the tab signal and clears the badge", () => {
  const signal = createTabSignal();
  signal.update({ count: 3, severity: "amber", attended: false });
  flush();
  expect(document.title).toBe("(3) Shepherd");

  signal.update({ count: 3, severity: "amber", attended: true });
  flush();
  expect(document.title).toBe("Shepherd");
  expect(link.type).toBe("image/svg+xml");
  expect(link.href).toContain("/favicon.svg");
  expect(clearBadge).toHaveBeenCalled();
});

test("N → 0 while backgrounded flourishes, then restores the default favicon", () => {
  const signal = createTabSignal();
  signal.update({ count: 2, severity: "amber", attended: false });
  flush();
  expect(link.href.startsWith("data:image/png")).toBe(true);

  signal.update({ count: 0, severity: "none", attended: false });
  flush();
  // flourish: still a PNG (the ✓), title cleared, badge cleared
  expect(link.href.startsWith("data:image/png")).toBe(true);
  expect(document.title).toBe("Shepherd");
  expect(clearBadge).toHaveBeenCalled();

  // after the flourish window, the default favicon is restored
  vi.advanceTimersByTime(2500);
  expect(link.type).toBe("image/svg+xml");
  expect(link.href).toContain("/favicon.svg");
});

test("dispose restores title/favicon and clears the badge", () => {
  const signal = createTabSignal();
  signal.update({ count: 1, severity: "red", attended: false });
  flush();
  expect(document.title).toBe("(1) Shepherd");

  signal.dispose();
  expect(document.title).toBe("Shepherd");
  expect(link.type).toBe("image/svg+xml");
  expect(link.href).toContain("/favicon.svg");
  expect(clearBadge).toHaveBeenCalled();
});
