import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { toasts } from "./toasts.svelte";

beforeEach(() => {
  vi.useFakeTimers();
  // start each test from a clean queue
  for (const t of [...toasts.items]) toasts.close(t.id);
});

afterEach(() => {
  vi.useRealTimers();
});

test("pendingUndo tracks a keyed undo across its window", () => {
  expect(toasts.pendingUndo("s1")).toBe(false);

  toasts.undo("decommissioned", { undoLabel: "UNDO", key: "s1", onCommit: () => {} });
  expect(toasts.pendingUndo("s1")).toBe(true);
  expect(toasts.pendingUndo("s2")).toBe(false);
});

test("pendingUndo clears when the window expires (commit fires)", async () => {
  const onCommit = vi.fn();
  toasts.undo("decommissioned", { undoLabel: "UNDO", key: "s1", onCommit, duration: 5000 });
  expect(toasts.pendingUndo("s1")).toBe(true);

  await vi.advanceTimersByTimeAsync(5000);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(toasts.pendingUndo("s1")).toBe(false);
});

test("pendingUndo clears when UNDO is pressed", () => {
  const onUndo = vi.fn();
  const id = toasts.undo("decommissioned", {
    undoLabel: "UNDO",
    key: "s1",
    onCommit: () => {},
    onUndo,
  });
  expect(toasts.pendingUndo("s1")).toBe(true);

  toasts.cancel(id);
  expect(onUndo).toHaveBeenCalledOnce();
  expect(toasts.pendingUndo("s1")).toBe(false);
});

test("an unkeyed undo is not matched by pendingUndo", () => {
  toasts.undo("generic", { undoLabel: "UNDO", onCommit: () => {} });
  expect(toasts.pendingUndo("s1")).toBe(false);
});
