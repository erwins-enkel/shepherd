import { describe, it, expect } from "vitest";
import { expectMinPx, GEOMETRY_EPSILON } from "./geometry";

describe("expectMinPx — a11y floor with sub-pixel slack", () => {
  it("passes when the value carries only sub-pixel ULP noise under the floor", () => {
    // The exact flake shape: a 52px tier measured as 51.99998… (transform-mapped float).
    expect(() => expectMinPx(51.99998474121094, 52)).not.toThrow();
    expect(() => expectMinPx(44 - 1.5e-5, 44)).not.toThrow();
  });

  it("passes exactly at the floor and above", () => {
    expect(() => expectMinPx(52, 52)).not.toThrow();
    expect(() => expectMinPx(60, 52)).not.toThrow();
  });

  it("fails on a real regression a full pixel (or more) below the floor", () => {
    // A failing inner expect throws, so the sub-floor case is asserted via toThrow.
    expect(() => expectMinPx(51, 52)).toThrow();
    expect(() => expectMinPx(48, 52)).toThrow();
  });

  it("keeps the epsilon far below one pixel so it cannot mask a real regression", () => {
    expect(GEOMETRY_EPSILON).toBeLessThan(1);
    // Just under the floor by more than epsilon must fail.
    expect(() => expectMinPx(52 - GEOMETRY_EPSILON - 0.01, 52)).toThrow();
  });
});
