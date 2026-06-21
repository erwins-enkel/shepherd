import { describe, it, expect } from "vitest";
import { formatUnits, formatPct, formatDollars } from "./format";

describe("formatUnits", () => {
  it("renders raw counts below 1K verbatim", () => {
    expect(formatUnits(0)).toBe("0");
    expect(formatUnits(42)).toBe("42");
    expect(formatUnits(999)).toBe("999");
  });

  it("rounds fractional weighted units", () => {
    // [0.1, 1) — one decimal
    expect(formatUnits(0.5)).toBe("0.5");
    expect(formatUnits(0.74)).toBe("0.7");
    // <0.1 — clamp label
    expect(formatUnits(0.04)).toBe("<0.1");
    // [1, 10) decimal
    expect(formatUnits(8.05)).toBe("8.1");
    // ≥10 integer rounding
    expect(formatUnits(53.9247)).toBe("54");
    expect(formatUnits(9.96)).toBe("10");
    // boundary: rounds to 1000 → "1K"
    expect(formatUnits(999.6)).toBe("1K");
  });

  it("renders thousands with a rounded K suffix", () => {
    expect(formatUnits(1_000)).toBe("1K");
    expect(formatUnits(12_400)).toBe("12K");
    expect(formatUnits(512_000)).toBe("512K");
  });

  it("renders millions with two decimals and an M suffix", () => {
    expect(formatUnits(1_000_000)).toBe("1.00M");
    expect(formatUnits(1_240_000)).toBe("1.24M");
  });

  it("promotes the rounding boundary to M instead of emitting 1000K", () => {
    expect(formatUnits(999_500)).toBe("1.00M");
    expect(formatUnits(999_999)).toBe("1.00M");
    // just below the boundary stays in K
    expect(formatUnits(999_499)).toBe("999K");
  });
});

describe("formatPct", () => {
  it("renders a fraction as a rounded percentage", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(0.357)).toBe("36%");
    expect(formatPct(1)).toBe("100%");
  });
});

describe("formatDollars", () => {
  it("renders small amounts with two decimal places", () => {
    expect(formatDollars(5.42)).toBe("$5.42");
    expect(formatDollars(0.28)).toBe("$0.28");
  });

  it("renders thousands with one decimal place and K suffix", () => {
    expect(formatDollars(1500)).toBe("$1.5K");
  });

  it("renders millions with two decimal places and M suffix", () => {
    expect(formatDollars(2_500_000)).toBe("$2.50M");
  });
});
