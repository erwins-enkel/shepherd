import { describe, expect, it } from "vitest";
import { computeStitchPlan, cropRegionForElement } from "../src/lib/screenshot";

describe("computeStitchPlan", () => {
  it("returns a single step for a page that fits the viewport", () => {
    const plan = computeStitchPlan({ pageHeight: 600, viewportHeight: 800, maxTiles: 12 });
    expect(plan.steps).toEqual([0]);
    expect(plan.coveredHeight).toBe(600);
    expect(plan.truncated).toBe(false);
  });

  it("steps by viewport height and clamps the last slice to the page bottom", () => {
    // 2000 / 800 → tiles at 0, 800, then clamp last to 1200 (2000-800)
    const plan = computeStitchPlan({ pageHeight: 2000, viewportHeight: 800, maxTiles: 12 });
    expect(plan.steps).toEqual([0, 800, 1200]);
    expect(plan.coveredHeight).toBe(2000);
    expect(plan.truncated).toBe(false);
  });

  it("does not clamp when the page is an exact multiple of the viewport", () => {
    const plan = computeStitchPlan({ pageHeight: 1600, viewportHeight: 800, maxTiles: 12 });
    expect(plan.steps).toEqual([0, 800]);
    expect(plan.coveredHeight).toBe(1600);
    expect(plan.truncated).toBe(false);
  });

  it("caps the tile count and flags truncation, covering only the captured height", () => {
    const plan = computeStitchPlan({ pageHeight: 10000, viewportHeight: 800, maxTiles: 3 });
    expect(plan.steps).toEqual([0, 800, 1600]);
    expect(plan.coveredHeight).toBe(2400);
    expect(plan.truncated).toBe(true);
  });

  it("treats a zero/!finite viewport as a single visible slice", () => {
    const plan = computeStitchPlan({ pageHeight: 2000, viewportHeight: 0, maxTiles: 12 });
    expect(plan.steps).toEqual([0]);
    expect(plan.truncated).toBe(false);
  });
});

describe("cropRegionForElement", () => {
  const viewport = { width: 1000, height: 800 };

  it("scales a fully-visible rect to device pixels", () => {
    const region = cropRegionForElement({ x: 100, y: 50, width: 200, height: 100 }, viewport, 2);
    expect(region).toEqual({ sx: 200, sy: 100, sw: 400, sh: 200 });
  });

  it("clamps a rect that overflows the viewport edges", () => {
    const region = cropRegionForElement({ x: 900, y: 700, width: 400, height: 400 }, viewport, 1);
    // clamped to 900..1000 × 700..800
    expect(region).toEqual({ sx: 900, sy: 700, sw: 100, sh: 100 });
  });

  it("clamps negative offsets (element scrolled partly above/left)", () => {
    const region = cropRegionForElement({ x: -50, y: -20, width: 200, height: 100 }, viewport, 1);
    expect(region).toEqual({ sx: 0, sy: 0, sw: 150, sh: 80 });
  });

  it("returns null when the element is fully offscreen", () => {
    expect(
      cropRegionForElement({ x: 1200, y: 50, width: 100, height: 100 }, viewport, 1),
    ).toBeNull();
  });

  it("returns null for a zero-area rect", () => {
    expect(cropRegionForElement({ x: 10, y: 10, width: 0, height: 50 }, viewport, 1)).toBeNull();
  });
});
