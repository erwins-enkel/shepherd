import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { pollWhileVisible } from "./visibility";

// minimal document stub: `hidden` flag + visibilitychange listeners
function stubDoc(state: { hidden: boolean }) {
  const handlers: (() => void)[] = [];
  (globalThis as unknown as { document: unknown }).document = {
    get hidden() {
      return state.hidden;
    },
    addEventListener: (_t: string, h: () => void) => handlers.push(h),
    removeEventListener: (_t: string, h: () => void) => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
  return { fire: () => [...handlers].forEach((h) => h()), handlers };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { document?: unknown }).document;
});

test("ticks fire while the tab is visible", () => {
  stubDoc({ hidden: false });
  const fn = vi.fn();
  const stop = pollWhileVisible(fn, 1000);
  vi.advanceTimersByTime(3000);
  expect(fn).toHaveBeenCalledTimes(3);
  stop();
});

test("ticks are skipped while the tab is hidden; return fires an immediate refresh", () => {
  const state = { hidden: true };
  const doc = stubDoc(state);
  const fn = vi.fn();
  const stop = pollWhileVisible(fn, 1000);
  vi.advanceTimersByTime(5000); // hidden: no network ticks
  expect(fn).not.toHaveBeenCalled();
  state.hidden = false;
  doc.fire(); // visibilitychange → visible: immediate refresh, not interval-stale
  expect(fn).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000); // cadence resumes
  expect(fn).toHaveBeenCalledTimes(2);
  stop();
});

test("a hidden→hidden visibilitychange does not refresh", () => {
  const doc = stubDoc({ hidden: true });
  const fn = vi.fn();
  const stop = pollWhileVisible(fn, 1000);
  doc.fire();
  expect(fn).not.toHaveBeenCalled();
  stop();
});

test("the disposer stops ticks and detaches the listener", () => {
  const doc = stubDoc({ hidden: false });
  const fn = vi.fn();
  const stop = pollWhileVisible(fn, 1000);
  stop();
  vi.advanceTimersByTime(3000);
  expect(fn).not.toHaveBeenCalled();
  expect(doc.handlers).toHaveLength(0);
});
