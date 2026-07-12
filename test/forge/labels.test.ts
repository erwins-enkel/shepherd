import { test, expect } from "bun:test";
import { normalizeHex, labelColorsFrom } from "../../src/forge/labels";

test("normalizeHex accepts bare and #-prefixed 6-hex, lowercasing", () => {
  expect(normalizeHex("00AABB")).toBe("#00aabb");
  expect(normalizeHex("#00AaBb")).toBe("#00aabb");
  expect(normalizeHex("  d73a4a  ")).toBe("#d73a4a");
});

test("normalizeHex rejects anything not exactly 6 hex digits", () => {
  expect(normalizeHex("fff")).toBeUndefined();
  expect(normalizeHex("#gggggg")).toBeUndefined();
  expect(normalizeHex("1234567")).toBeUndefined();
  expect(normalizeHex("")).toBeUndefined();
});

test("labelColorsFrom maps valid colors and skips missing/invalid ones", () => {
  expect(
    labelColorsFrom([
      { name: "bug", color: "d73a4a" },
      { name: "feature", color: "#5319e7" },
      { name: "no-color", color: null },
      { name: "bad", color: "zzz" },
      { name: null, color: "abcdef" },
    ]),
  ).toEqual({ bug: "#d73a4a", feature: "#5319e7" });
});

test("labelColorsFrom returns undefined (not {}) when nothing contributes a color", () => {
  expect(labelColorsFrom([])).toBeUndefined();
  expect(labelColorsFrom([{ name: "x", color: null }])).toBeUndefined();
});
