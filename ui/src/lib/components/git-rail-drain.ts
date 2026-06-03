/** Pure helpers for the auto-drain config popover in GitRail.
 *  Extracted so they can be unit-tested independently of the Svelte component. */

/** Clamp an agent cap to an integer in [1, 20]. NaN/falsy → 1. */
export function clampCap(n: number): number {
  return Math.min(20, Math.max(1, Math.round(n || 1)));
}

/** Clamp a usage ceiling to an integer in [0, 100]. NaN/falsy → 0. */
export function clampCeiling(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n || 0)));
}

/** Trim the label; return null when the result is empty (signals "revert, don't send"). */
export function sanitizeLabel(s: string): string | null {
  const t = s.trim();
  return t || null;
}
