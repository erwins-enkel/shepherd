/** Display helpers reused across all usage lenses. */

/**
 * Format a raw unit count into a human-readable string.
 * ≥1M → 2 decimal places + "M"; ≥1K → rounded integer + "K"; else as-is.
 */
export function formatUnits(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) {
    // Guard the rounding boundary: values in [999_500, 999_999] round to
    // 1000K — promote those to "1.00M" instead.
    const k = Math.round(n / 1_000);
    return k >= 1_000 ? (n / 1_000_000).toFixed(2) + "M" : k + "K";
  }
  if (n === 0) return "0";
  if (n < 0.1) return "<0.1";
  if (n < 10) return n.toFixed(1).replace(/\.0$/, "");
  const rounded = Math.round(n);
  return rounded >= 1000 ? "1K" : String(rounded);
}

/**
 * Format a fraction (0–1) as a rounded percentage string, e.g. 0.357 → "36%".
 */
export function formatPct(fraction: number): string {
  return Math.round(fraction * 100) + "%";
}

/**
 * Format a dollar amount as a human-readable USD string.
 * ≥1M → 2 decimal places + "M"; ≥1K → 1 decimal place + "K"; else 2 decimal places.
 */
export function formatDollars(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}
