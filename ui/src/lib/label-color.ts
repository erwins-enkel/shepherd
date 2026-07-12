/**
 * OKLCH-based label chip coloring (issue: labels-almost-invisible).
 *
 * Raw forge hex (e.g. GitHub label colors) used verbatim as chip text is often
 * illegible against Shepherd's near-black dark rows or near-white light rows —
 * some hues are naturally very light (yellow) or very dark (navy) at full
 * saturation, so a fixed L per theme, but true hue/chroma preserved, keeps the
 * text recognizably "that label's color" while pinning contrast: OKLCH's L
 * channel is built to be perceptually uniform, so holding L constant across
 * hues gives near-constant contrast against a fixed background regardless of
 * which hue a given label happens to be.
 *
 * Dependency-free (no CSS parsing/color libraries) — this module is pure math
 * translated directly from Björn Ottosson's OKLab/OKLCH reference formulas
 * (https://bottosson.github.io/posts/oklab/), so it can run in tests (node)
 * and components (browser) alike without any DOM/CSSOM access.
 */

/** Emitted `oklch()` literal strings for a single label's color, one set per theme.
 *  Plain literals (`oklch(L C H)` / `oklch(L C H / A)`) — NOT `oklch(from …)` relative
 *  syntax — so the value is portable to inline styles, not just CSS that resolves a
 *  base color at parse time. */
export interface LabelChipColors {
  textDark: string;
  borderDark: string;
  fillDark: string;
  textLight: string;
  borderLight: string;
  fillLight: string;
}

/**
 * Per-theme lightness/alpha constants for label chips — the single source of truth,
 * intended to be surfaced on the /design-system reference page (nothing reads it yet).
 * Hue and chroma always come
 * from the source label color; only L (and fill alpha) are pinned here, per theme,
 * so text stays legible against Shepherd's near-black dark rows / near-white light
 * rows regardless of which hue a given label happens to be.
 *
 * `textL`/`borderL` are shared for a theme (border reuses the text lightness target
 * region rather than needing its own tuning — it only needs to read as "the label's
 * color," not clear a text-contrast bar). `fillL`/`fillA` set a low-opacity tint wash
 * behind the chip.
 *
 * `textL` was verified against a gamut-aware worst-case WCAG contrast check (see
 * label-color.test.ts): for every hue, over the FULL in-gamut chroma range at the
 * pinned lightness (0 → maxInGamutChroma, since the browser gamut-maps an
 * out-of-gamut oklch() literal by reducing C while holding L/H), the minimum text
 * contrast vs the theme row bg clears 4.5:1. The starting values below already pass
 * with margin (dark ≈9.81:1, light ≈5.63:1), so no tuning was needed; see that
 * file's header comment for the exact worst-case (hue, chroma) per theme.
 */
export const LABEL_CHIP_THEME = {
  dark: { textL: 0.8, borderL: 0.55, fillL: 0.62, fillA: 0.15 },
  light: { textL: 0.48, borderL: 0.55, fillL: 0.62, fillA: 0.16 },
} as const;

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB `#rrggbb` hex → OKLCH chroma (C) and hue (H, degrees, [0,360)). The source
 *  lightness is intentionally discarded — callers substitute a per-theme constant.
 *  Exported for the forward-transform golden test; throws on a non-`#rrggbb` hex. */
export function hexToOklchCH(hex: string): { c: number; h: number } {
  const m = HEX_RE.exec(hex);
  if (!m) throw new Error(`invalid hex: ${hex}`);
  const int = parseInt(m[1], 16);
  const r = linearize(((int >> 16) & 0xff) / 255);
  const g = linearize(((int >> 8) & 0xff) / 255);
  const b = linearize((int & 0xff) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_c = Math.cbrt(m_);
  const s_ = Math.cbrt(s);

  const A = 1.9779984951 * l_ - 2.428592205 * m_c + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_c - 0.808675766 * s_;

  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { c, h };
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function oklch(l: number, c: number, h: number): string {
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)})`;
}

function oklchAlpha(l: number, c: number, h: number, a: number): string {
  return `oklch(${round(l, 4)} ${round(c, 4)} ${round(h, 2)} / ${round(a, 4)})`;
}

/**
 * Convert a forge label hex color to legible chip colors for both themes. Preserves
 * the source hue and chroma; substitutes a fixed per-theme lightness (see
 * {@link LABEL_CHIP_THEME}) so contrast stays roughly constant across all hues.
 *
 * Returns `null` for anything that isn't a strict `#rrggbb` hex — callers fall back
 * to the neutral chip styling in that case.
 */
export function labelChipColors(hex: string): LabelChipColors | null {
  if (!HEX_RE.test(hex)) return null;
  const { c, h } = hexToOklchCH(hex);
  const { dark, light } = LABEL_CHIP_THEME;
  return {
    textDark: oklch(dark.textL, c, h),
    borderDark: oklch(dark.borderL, c, h),
    fillDark: oklchAlpha(dark.fillL, c, h, dark.fillA),
    textLight: oklch(light.textL, c, h),
    borderLight: oklch(light.borderL, c, h),
    fillLight: oklchAlpha(light.fillL, c, h, light.fillA),
  };
}

/** Inline `style=""` custom-property declarations for a hued label chip, or null for an
 *  invalid hex. Components apply these vars; their CSS picks per theme. Keeps the `--lc-*`
 *  var names in one place. */
export function labelChipStyle(hex: string): string | null {
  const c = labelChipColors(hex);
  if (!c) return null;
  return (
    `--lc-text-d:${c.textDark};--lc-border-d:${c.borderDark};--lc-fill-d:${c.fillDark};` +
    `--lc-text-l:${c.textLight};--lc-border-l:${c.borderLight};--lc-fill-l:${c.fillLight}`
  );
}
