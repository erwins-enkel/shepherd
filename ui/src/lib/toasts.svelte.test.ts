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

test("hold() pauses a timed info toast past its deadline", async () => {
  const id = toasts.info("saved", { duration: 4000 });
  toasts.hold(id);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(toasts.items.some((t) => t.id === id)).toBe(true);
});

test("release() resumes with the remaining time, not a fresh window", async () => {
  const id = toasts.info("saved", { duration: 4000 });

  await vi.advanceTimersByTimeAsync(1000); // 3s left
  toasts.hold(id);
  await vi.advanceTimersByTimeAsync(60_000); // held: clock irrelevant
  toasts.release(id);

  await vi.advanceTimersByTimeAsync(2999);
  expect(toasts.items.some((t) => t.id === id)).toBe(true); // not earlier
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts.items.some((t) => t.id === id)).toBe(false); // exactly the 3s remainder
});

test("holds are ref-counted: one release of two keeps the toast paused", async () => {
  const id = toasts.info("saved", { duration: 4000 });
  toasts.hold(id); // hover
  toasts.hold(id); // + keyboard focus

  toasts.release(id); // pointer leaves, still focused
  await vi.advanceTimersByTimeAsync(10_000);
  expect(toasts.items.some((t) => t.id === id)).toBe(true);

  toasts.release(id); // focus leaves too
  await vi.advanceTimersByTimeAsync(4000);
  expect(toasts.items.some((t) => t.id === id)).toBe(false);
});

test("release() never goes below zero (stray release then hold still pauses)", async () => {
  const id = toasts.info("saved", { duration: 4000 });
  toasts.release(id); // stray — no hold outstanding
  toasts.hold(id);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(toasts.items.some((t) => t.id === id)).toBe(true);
});

test("hold() no-ops on a sticky info toast", async () => {
  const id = toasts.info("failed", { sticky: true });
  toasts.hold(id);
  toasts.release(id);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(toasts.items.some((t) => t.id === id)).toBe(true); // still persistent
});

test("hold() no-ops on undo toasts: the commit deadline stands", async () => {
  const onCommit = vi.fn();
  const id = toasts.undo("decommissioned", { undoLabel: "UNDO", onCommit, duration: 5000 });
  toasts.hold(id);

  await vi.advanceTimersByTimeAsync(5000);
  expect(onCommit).toHaveBeenCalledOnce();
  expect(toasts.items.some((t) => t.id === id)).toBe(false);
});

test("a finite-duration info toast carries durationMs (drives the bar)", () => {
  const id = toasts.info("saved", { duration: 4000 });
  expect(toasts.items.find((t) => t.id === id)?.durationMs).toBe(4000);
});

test("a default-duration info toast carries durationMs", () => {
  const id = toasts.info("saved");
  expect(toasts.items.find((t) => t.id === id)?.durationMs).toBe(4000);
});

test("a sticky info toast has no durationMs (no bar) and never auto-dismisses", async () => {
  const id = toasts.info("failed", { sticky: true });
  expect(toasts.items.find((t) => t.id === id)?.durationMs).toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(toasts.items.some((t) => t.id === id)).toBe(true);
});

test("a failure info toast (alert) carries durationMs 12000 and auto-dismisses at 12s", async () => {
  const id = toasts.info("failed", { alert: true });
  expect(toasts.items.find((t) => t.id === id)?.durationMs).toBe(12000);
  await vi.advanceTimersByTimeAsync(11_999);
  expect(toasts.items.some((t) => t.id === id)).toBe(true); // still up just before the window
  await vi.advanceTimersByTimeAsync(2);
  expect(toasts.items.some((t) => t.id === id)).toBe(false); // gone after 12s
});

test("an explicit duration overrides the alert failure default", () => {
  const id = toasts.info("failed", { alert: true, duration: 3000 });
  expect(toasts.items.find((t) => t.id === id)?.durationMs).toBe(3000);
});

test("a keyed refresh bumps armSeq (restarts the bar animation)", () => {
  const id = toasts.info("saved", { key: "k", duration: 4000 });
  expect(toasts.items.find((t) => t.id === id)?.armSeq).toBe(0);
  expect(toasts.info("saved again", { key: "k", duration: 4000 })).toBe(id);
  expect(toasts.items.find((t) => t.id === id)?.armSeq).toBe(1);
});

test("hold()/release() toggle the item's held flag; ref-counted", () => {
  const id = toasts.info("saved", { duration: 4000 });
  const get = () => toasts.items.find((t) => t.id === id);
  expect(get()?.held).toBeFalsy();

  toasts.hold(id);
  expect(get()?.held).toBe(true);
  toasts.release(id);
  expect(get()?.held).toBe(false);

  // ref-counting: two holds, one release stays held; second release clears it
  toasts.hold(id);
  toasts.hold(id);
  expect(get()?.held).toBe(true);
  toasts.release(id);
  expect(get()?.held).toBe(true);
  toasts.release(id);
  expect(get()?.held).toBe(false);
});

test("keyed refresh while held doesn't re-arm under the pointer", async () => {
  const id = toasts.info("failed", { key: "k1", duration: 4000 });
  toasts.hold(id);

  expect(toasts.info("failed again", { key: "k1", duration: 2000 })).toBe(id);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(toasts.items.some((t) => t.id === id)).toBe(true); // still under the pointer

  toasts.release(id);
  await vi.advanceTimersByTimeAsync(1999);
  expect(toasts.items.some((t) => t.id === id)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(toasts.items.some((t) => t.id === id)).toBe(false); // refreshed duration applies
});
