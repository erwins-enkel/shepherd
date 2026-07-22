import { expect } from "vitest";

/**
 * Sub-pixel slack for a11y geometry floors.
 *
 * `getBoundingClientRect()` returns the transform-mapped border box as floats, so a box
 * whose CSS `min-height` is exactly a tier can measure a few float32 ULPs under it
 * (~1.5e-5px) when an ancestor carries an animating transform (e.g. a Svelte `fly` sheet).
 * That is imperceptible float noise, not a real geometry regression — but `51.99998… >= 52`
 * is false, so it flakes the gate.
 *
 * 0.05px is ~3000× the observed ULP noise yet ~20× below the smallest real regression (1px);
 * the a11y tiers are ≥4px apart, so this epsilon can never let a genuine floor regression pass.
 */
export const GEOMETRY_EPSILON = 0.05;

/**
 * Assert a measured px dimension meets an a11y sizing floor, tolerant of the sub-pixel float
 * noise transform-mapped `getBoundingClientRect()` values carry.
 *
 * @param value   Measured dimension (e.g. `el.getBoundingClientRect().height`). `undefined`
 *                is accepted for optional-chained call sites and still fails, unchanged.
 * @param floorPx The floor to meet — an integer tier or a runtime value (e.g. a parsed CSS var).
 * @param label   Optional context surfaced in the failure message (the raw call sites carry one).
 */
export function expectMinPx(value: number | undefined, floorPx: number, label?: string): void {
  expect(value, label).toBeGreaterThanOrEqual(floorPx - GEOMETRY_EPSILON);
}
