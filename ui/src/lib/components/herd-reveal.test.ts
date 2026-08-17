import { test, expect } from "vitest";
import { needsCentering } from "./herd-reveal";

// A 400px-tall rail viewport, as it sits in the page (not at y=0 — the top bar is above it),
// so a bug that assumed viewport-origin coordinates would show up here.
const view = { top: 100, bottom: 500 };

test("fully inside the viewport: no scroll (an already-visible row must not jitter)", () => {
  expect(needsCentering({ top: 200, bottom: 260 }, view)).toBe(false);
});

test("flush against either edge still counts as fully inside", () => {
  expect(needsCentering({ top: 100, bottom: 160 }, view)).toBe(false);
  expect(needsCentering({ top: 440, bottom: 500 }, view)).toBe(false);
});

test("clipped at the top edge: centre it", () => {
  expect(needsCentering({ top: 80, bottom: 140 }, view)).toBe(true);
});

test("clipped at the bottom edge: centre it", () => {
  expect(needsCentering({ top: 460, bottom: 520 }, view)).toBe(true);
});

test("entirely off-screen in either direction: centre it", () => {
  expect(needsCentering({ top: -200, bottom: -140 }, view)).toBe(true);
  expect(needsCentering({ top: 900, bottom: 960 }, view)).toBe(true);
});

test("taller than the viewport: can never be fully inside, so it centres", () => {
  expect(needsCentering({ top: 90, bottom: 700 }, view)).toBe(true);
});
