/** Display helpers reused across all usage lenses. */

/**
 * Format a raw unit count into a human-readable string.
 * ≥1M → 2 decimal places + "M"; ≥1K → rounded integer + "K"; else as-is.
 */
export function formatUnits(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

/**
 * Format a fraction (0–1) as a rounded percentage string, e.g. 0.357 → "36%".
 */
export function formatPct(fraction: number): string {
  return Math.round(fraction * 100) + "%";
}
