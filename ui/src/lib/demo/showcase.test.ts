import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { commandBarShowcase, startCommandBarShowcase, stopCommandBarShowcase } from "./showcase";

/** Minimal fake `window` (node test project has no DOM) supporting add/remove
 *  listener and manual event firing — mirrors the stub in store.svelte.test.ts. */
function stubWindow() {
  const on: Record<string, ((e?: unknown) => void)[]> = {};
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: (t: string, h: (e?: unknown) => void) => {
      (on[t] ??= []).push(h);
    },
    removeEventListener: (t: string, h: (e?: unknown) => void) => {
      on[t] = (on[t] ?? []).filter((x) => x !== h);
    },
  };
  return { fire: (t: string) => (on[t] ?? []).slice().forEach((h) => h()) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopCommandBarShowcase();
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.useRealTimers();
});

describe("commandBarShowcase — one-shot idle-gated open", () => {
  it("opens with the seeded filter after the idle delay, then closes on its own", () => {
    stubWindow();
    startCommandBarShowcase();
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });

    vi.advanceTimersByTime(3500);
    expect(get(commandBarShowcase)).toEqual({ open: true, filter: "store" });

    vi.advanceTimersByTime(2800);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
  });

  it("never opens if the visitor interacts (keydown) before the delay fires", () => {
    const { fire } = stubWindow();
    startCommandBarShowcase();
    vi.advanceTimersByTime(1000);
    fire("keydown");
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
  });

  it("never opens if the visitor interacts (pointerdown) before the delay fires", () => {
    const { fire } = stubWindow();
    startCommandBarShowcase();
    vi.advanceTimersByTime(1000);
    fire("pointerdown");
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
  });

  it("stays OPEN if the visitor interacts (keydown) DURING the open window — never yanked shut", () => {
    const { fire } = stubWindow();
    startCommandBarShowcase();
    vi.advanceTimersByTime(3500);
    expect(get(commandBarShowcase)).toEqual({ open: true, filter: "store" });
    // Visitor starts typing in the just-opened bar — the forced close must be cancelled.
    fire("keydown");
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: true, filter: "store" });
  });

  it("stays OPEN if the visitor interacts (pointerdown) DURING the open window", () => {
    const { fire } = stubWindow();
    startCommandBarShowcase();
    vi.advanceTimersByTime(3500);
    expect(get(commandBarShowcase)).toEqual({ open: true, filter: "store" });
    fire("pointerdown");
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: true, filter: "store" });
  });

  it("is idempotent — a second call never schedules a duplicate beat", () => {
    stubWindow();
    startCommandBarShowcase();
    startCommandBarShowcase();
    vi.advanceTimersByTime(3500);
    expect(get(commandBarShowcase)).toEqual({ open: true, filter: "store" });
    // Only one close timer should be pending — advancing once fully closes it
    // and it stays closed (a duplicate close timer would still no-op here,
    // but this also guards there's no duplicate OPEN waiting behind it).
    vi.advanceTimersByTime(2800);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
  });

  it("is a no-op outside the browser (no window global)", () => {
    expect(() => startCommandBarShowcase()).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
  });

  it("stopCommandBarShowcase clears a pending open before it fires", () => {
    stubWindow();
    startCommandBarShowcase();
    vi.advanceTimersByTime(1000);
    stopCommandBarShowcase();
    vi.advanceTimersByTime(10_000);
    expect(get(commandBarShowcase)).toEqual({ open: false, filter: "" });
  });
});
