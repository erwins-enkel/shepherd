/** Numeric major.minor.patch comparison. Returns >0 if a>b, <0 if a<b, 0 if equal.
 *  Missing/garbage segments coerce to 0, so "0.6" compares as "0.6.0".
 *
 *  Leaf module (no imports) so it can be shared by herdr-update.ts and herdr-capabilities.ts
 *  without an import cycle. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
