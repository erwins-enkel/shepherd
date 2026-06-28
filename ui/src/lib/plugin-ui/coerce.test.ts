import { describe, expect, it } from "vitest";
import { coerceNumber, coerceMax, coerceText } from "./coerce";

describe("coerceNumber", () => {
  it("returns finite number unchanged", () => {
    expect(coerceNumber(42, 0)).toBe(42);
    expect(coerceNumber(0, 5)).toBe(0);
    expect(coerceNumber(-3.14, 1)).toBe(-3.14);
  });

  it("returns fallback for NaN input", () => {
    expect(coerceNumber(NaN, 7)).toBe(7);
    expect(coerceNumber("abc", 99)).toBe(99);
  });

  it("returns fallback for null", () => {
    expect(coerceNumber(null, 5)).toBe(5);
  });

  it("returns fallback for undefined", () => {
    expect(coerceNumber(undefined, 3)).toBe(3);
  });

  it("coerces numeric string", () => {
    expect(coerceNumber("42", 0)).toBe(42);
  });
});

describe("coerceMax", () => {
  it("returns value when >= 1", () => {
    expect(coerceMax(100, 10)).toBe(100);
    expect(coerceMax(1, 10)).toBe(1);
    expect(coerceMax(1.5, 10)).toBe(1.5);
  });

  it("clamps 0 to 1", () => {
    expect(coerceMax(0, 10)).toBe(1);
  });

  it("clamps negative to 1", () => {
    expect(coerceMax(-5, 10)).toBe(1);
  });

  it("uses fallback for NaN then clamps to >= 1", () => {
    expect(coerceMax(NaN, 50)).toBe(50);
    expect(coerceMax(NaN, 0)).toBe(1);
  });

  it("uses fallback for null", () => {
    expect(coerceMax(null, 100)).toBe(100);
  });
});

describe("coerceText", () => {
  it("returns non-empty string unchanged", () => {
    expect(coerceText("hello")).toBe("hello");
  });

  it("converts number to string", () => {
    expect(coerceText(42)).toBe("42");
  });

  it("returns null for empty string", () => {
    expect(coerceText("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(coerceText("  ")).toBeNull();
    expect(coerceText("\t\n")).toBeNull();
  });

  it("returns null for null", () => {
    expect(coerceText(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(coerceText(undefined)).toBeNull();
  });
});
