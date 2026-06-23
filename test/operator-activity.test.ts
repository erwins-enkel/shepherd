import { expect, test } from "bun:test";
import {
  getLastOperatorKeystrokeAt,
  isOperatorKeystroke,
  stampOperatorKeystroke,
} from "../src/operator-activity";

test("a normal keystroke frame counts as operator input", () => {
  expect(isOperatorKeystroke("a")).toBe(true);
  expect(isOperatorKeystroke("ls -la\r")).toBe(true);
  expect(isOperatorKeystroke("\x1b[A")).toBe(true); // arrow key
});

test("a resize control frame is NOT operator input", () => {
  expect(isOperatorKeystroke("\x00resize:80:24\n")).toBe(false);
  expect(isOperatorKeystroke("\x00resize:120:40\n")).toBe(false);
});

test("stamp writes the timestamp and getLast reads it back", () => {
  const map = new Map<string, number>();
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBeUndefined();
  expect(stampOperatorKeystroke(map, "s1", 1000)).toBe(true);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
});

test("stamp is throttled to ~1/sec per session", () => {
  const map = new Map<string, number>();
  expect(stampOperatorKeystroke(map, "s1", 1000)).toBe(true);
  // within the throttle window → no-op, value unchanged
  expect(stampOperatorKeystroke(map, "s1", 1500)).toBe(false);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
  // at/after the window → stamps again
  expect(stampOperatorKeystroke(map, "s1", 2000)).toBe(true);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(2000);
});

test("throttle is per session id", () => {
  const map = new Map<string, number>();
  expect(stampOperatorKeystroke(map, "s1", 1000)).toBe(true);
  expect(stampOperatorKeystroke(map, "s2", 1000)).toBe(true); // different session, not throttled
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
  expect(getLastOperatorKeystrokeAt(map, "s2")).toBe(1000);
});

test("a resize frame, when correctly skipped, never advances the seam", () => {
  // Mirrors the server gating: only stamp when isOperatorKeystroke(frame).
  const map = new Map<string, number>();
  const feed = (frame: string, now: number) => {
    if (isOperatorKeystroke(frame)) stampOperatorKeystroke(map, "s1", now);
  };
  feed("\x00resize:80:24\n", 1000);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBeUndefined();
  feed("x", 1000);
  expect(getLastOperatorKeystrokeAt(map, "s1")).toBe(1000);
});
