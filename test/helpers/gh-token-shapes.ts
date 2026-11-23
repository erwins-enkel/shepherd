/** A fake GitHub App installation token in GitHub's current shape (observed 2026-11): `ghs_` +
 *  three base64url segments joined by `.`, 390 chars, with `_` and `-` inside the segments.
 *  The old shape (`ghs_` + 36 alphanumerics) is what most fixtures still use. */
export const CURRENT_GHS_TOKEN = `ghs_${"aB3_".repeat(11)}.${"x-Y9".repeat(63)}zz.${"Q_r-".repeat(21)}k7`;
