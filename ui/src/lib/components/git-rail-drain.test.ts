import { describe, it, expect } from "vitest";
import { clampCap, clampCeiling, sanitizeLabel } from "./git-rail-drain";

describe("clampCap", () => {
  it("floors a decimal to the nearest integer", () => expect(clampCap(1.4)).toBe(1));
  it("clamps 0 up to 1", () => expect(clampCap(0)).toBe(1));
  it("clamps 25 down to 20", () => expect(clampCap(25)).toBe(20));
  it("treats NaN as 1", () => expect(clampCap(NaN)).toBe(1));
  it("passes a valid value through", () => expect(clampCap(7)).toBe(7));
});

describe("clampCeiling", () => {
  it("clamps -5 up to 0", () => expect(clampCeiling(-5)).toBe(0));
  it("clamps 150 down to 100", () => expect(clampCeiling(150)).toBe(100));
  it("passes a valid value through", () => expect(clampCeiling(50)).toBe(50));
  it("treats NaN as 0", () => expect(clampCeiling(NaN)).toBe(0));
  it("floors 99.9 to 100 via round", () => expect(clampCeiling(99.9)).toBe(100));
});

describe("sanitizeLabel", () => {
  it("trims surrounding whitespace", () => expect(sanitizeLabel("  x  ")).toBe("x"));
  it("returns null for an empty string", () => expect(sanitizeLabel("")).toBeNull());
  it("returns null for whitespace-only string", () => expect(sanitizeLabel("   ")).toBeNull());
});
