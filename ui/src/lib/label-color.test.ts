/**
 * Tests for label-color.ts (issue: labels-almost-invisible).
 *
 * The core acceptance gate is contrast: label chip TEXT must clear WCAG 4.5:1
 * against the row background it sits on, for every hue AND chroma a forge label
 * could plausibly resolve to on screen, in both themes.
 *
 * Gamut-aware check (this matters): the chip text is emitted as a plain `oklch(L C H)`
 * literal at the pinned per-theme lightness, but real forge labels reach chroma well
 * beyond what's displayable at that L (e.g. GitHub #7057ff ≈ C 0.24). A browser
 * gamut-maps an out-of-gamut `oklch()` by REDUCING chroma while holding L and H (CSS
 * Color 4) — so the set of colors that can actually paint at lightness L is exactly
 * `{ oklch(L, c, H) : 0 ≤ c ≤ maxInGamutChroma(L, H) }`. We therefore, per hue,
 * binary-search that max in-gamut chroma and sample the whole 0→maxC segment
 * (including c=0, the neutral gray), inverting each `oklch(L C H)` back to sRGB (the
 * reverse of label-color.ts's forward hex→OKLCH transform) to compute WCAG relative
 * luminance / contrast per WCAG 2.x. The worst case over all hues+chromas is the real
 * bound — sampling a single fixed (out-of-gamut) chroma would report an artifact.
 *
 * Backgrounds are `--inset` from src/app.css: dark `#070a09`, light `#f3f6f4`.
 *
 * Tuning record: the task's STARTING constants (dark textL 0.80, light textL 0.48)
 * were run through the gamut-aware gate below and already clear 4.5:1 with margin, so
 * no adjustment was needed. True worst cases:
 *   dark:  ≈9.81:1 at (hue 330, chroma 0.187)   [neutral c=0 ≈10.64:1]
 *   light: ≈5.63:1 at (hue 145, chroma 0.151)   [neutral c=0 ≈6.01:1]
 * The exact numbers are re-derived and asserted (and printed to the console) below.
 */
import { describe, it, expect } from "vitest";
import { labelChipColors, hexToOklchCH, LABEL_CHIP_THEME } from "./label-color";

// ── inverse OKLCH → linear sRGB + gamma-encoded sRGB (Ottosson), local to this test ─

function oklchToLinearRgb(l: number, c: number, hDeg: number): { r: number; g: number; b: number } {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const ll = l_ ** 3;
  const mm = m_ ** 3;
  const ss = s_ ** 3;

  return {
    r: 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
    g: -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
    b: -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
  };
}

function gammaEncode(c: number): number {
  const clamped = Math.min(1, Math.max(0, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function oklchToSrgb(l: number, c: number, hDeg: number): { r: number; g: number; b: number } {
  const { r, g, b } = oklchToLinearRgb(l, c, hDeg);
  return { r: gammaEncode(r), g: gammaEncode(g), b: gammaEncode(b) };
}

/** True iff `oklch(l c h)` is inside the sRGB gamut (all linear channels within
 *  [0,1] before clamping; small epsilon tolerates float noise at the boundary). */
function inGamut(l: number, c: number, hDeg: number, eps = 1e-4): boolean {
  const { r, g, b } = oklchToLinearRgb(l, c, hDeg);
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;
}

/** Largest chroma such that `oklch(l c h)` stays in the sRGB gamut, by binary search.
 *  Mirrors how a browser clamps an out-of-gamut label color: reduce C, hold L and H. */
function maxInGamutChroma(l: number, hDeg: number): number {
  let lo = 0;
  let hi = 0.5; // beyond any sRGB chroma at these lightnesses
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(l, mid, hDeg)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Parse a plain `oklch(L C H)` (optionally `/ A`, ignored here) literal, as emitted
 *  by label-color.ts, into its numeric components. */
function parseOklch(str: string): { l: number; c: number; h: number } {
  const m = /oklch\(([-\d.]+) ([-\d.]+) ([-\d.]+)(?: \/ [-\d.]+)?\)/.exec(str);
  if (!m) throw new Error(`not a plain oklch() literal: ${str}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

// ── WCAG contrast ────────────────────────────────────────────────────────────────

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const int = parseInt(hex.slice(1), 16);
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255,
  };
}

function contrastRatio(
  fg: { r: number; g: number; b: number },
  bg: { r: number; g: number; b: number },
): number {
  const lFg = relativeLuminance(fg.r, fg.g, fg.b);
  const lBg = relativeLuminance(bg.r, bg.g, bg.b);
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

// --inset from ui/src/app.css
const ROW_BG_DARK = hexToRgb01("#070a09");
const ROW_BG_LIGHT = hexToRgb01("#f3f6f4");

const WCAG_AA_TEXT = 4.5;

/** Global worst-case (minimum) text contrast at lightness `textL` over every hue
 *  (5° steps) and, per hue, the full in-gamut chroma range (0 → maxC, 12 steps incl.
 *  c=0), against `bg`. Returns the ratio and the (hue, chroma) where it occurs. */
function worstCaseContrast(
  textL: number,
  bg: { r: number; g: number; b: number },
): { ratio: number; hue: number; chroma: number } {
  let worst = Infinity;
  let worstHue = -1;
  let worstChroma = -1;
  for (let h = 0; h < 360; h += 5) {
    const maxC = maxInGamutChroma(textL, h);
    for (let k = 0; k <= 12; k++) {
      const c = (maxC * k) / 12;
      const ratio = contrastRatio(oklchToSrgb(textL, c, h), bg);
      if (ratio < worst) {
        worst = ratio;
        worstHue = h;
        worstChroma = c;
      }
    }
  }
  return { ratio: worst, hue: worstHue, chroma: worstChroma };
}

describe("labelChipColors", () => {
  it("returns null for an invalid hex", () => {
    expect(labelChipColors("not-a-color")).toBeNull();
    expect(labelChipColors("#fff")).toBeNull(); // 3-digit shorthand unsupported
    expect(labelChipColors("#gggggg")).toBeNull();
    expect(labelChipColors("")).toBeNull();
  });

  it("returns non-null well-formed oklch() literals for a valid hex", () => {
    const result = labelChipColors("#1d76db"); // GitHub's default blue label color
    expect(result).not.toBeNull();
    const oklchLiteral = /^oklch\([-\d.]+ [-\d.]+ [-\d.]+\)$/;
    const oklchAlphaLiteral = /^oklch\([-\d.]+ [-\d.]+ [-\d.]+ \/ [-\d.]+\)$/;
    expect(result!.textDark).toMatch(oklchLiteral);
    expect(result!.borderDark).toMatch(oklchLiteral);
    expect(result!.fillDark).toMatch(oklchAlphaLiteral);
    expect(result!.textLight).toMatch(oklchLiteral);
    expect(result!.borderLight).toMatch(oklchLiteral);
    expect(result!.fillLight).toMatch(oklchAlphaLiteral);
  });

  it("preserves hue/chroma while swapping in the per-theme text lightness", () => {
    const result = labelChipColors("#1d76db")!;
    const dark = parseOklch(result.textDark);
    const light = parseOklch(result.textLight);
    expect(dark.l).toBeCloseTo(LABEL_CHIP_THEME.dark.textL, 4);
    expect(light.l).toBeCloseTo(LABEL_CHIP_THEME.light.textL, 4);
    // same source color -> same hue/chroma in both themes
    expect(dark.h).toBeCloseTo(light.h, 1);
    expect(dark.c).toBeCloseTo(light.c, 3);
  });

  it("round-trips a neutral achromatic hex to near-zero chroma", () => {
    const result = labelChipColors("#888888")!;
    const dark = parseOklch(result.textDark);
    expect(dark.c).toBeLessThan(0.01);
  });
});

describe("hexToOklchCH (forward-transform golden matrix)", () => {
  // Expected C/H computed independently once (Ottosson sRGB→OKLab, 6-dp) and pinned
  // here so a regression in any matrix coefficient is caught. Tolerances are generous
  // vs the pinned value but far tighter than any coefficient typo would land within.
  const cases: Array<{ hex: string; c: number; h: number }> = [
    { hex: "#1d76db", c: 0.174084, h: 255.394105 }, // GitHub blue
    { hex: "#d73a4a", c: 0.192675, h: 20.10446 }, // GitHub "bug" red
    { hex: "#7057ff", c: 0.236968, h: 282.959304 }, // GitHub "good first issue" violet
  ];
  for (const { hex, c, h } of cases) {
    it(`maps ${hex} to the known C/H`, () => {
      const got = hexToOklchCH(hex);
      expect(got.c).toBeCloseTo(c, 4);
      expect(got.h).toBeCloseTo(h, 2);
    });
  }
});

describe("gamut-aware worst-case contrast (WCAG AA, 4.5:1)", () => {
  it(`dark theme: text clears ${WCAG_AA_TEXT}:1 vs --inset (#070a09) over all hues+chromas`, () => {
    const { textL } = LABEL_CHIP_THEME.dark;
    const worst = worstCaseContrast(textL, ROW_BG_DARK);
     
    console.log(
      `[label-color] dark worst-case: ratio=${worst.ratio.toFixed(3)} @ (hue=${worst.hue}, chroma=${worst.chroma.toFixed(4)})`,
    );
    expect(worst.ratio).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    // explicit neutral (c=0) assertion — a grey label must also pass
    expect(contrastRatio(oklchToSrgb(textL, 0, 0), ROW_BG_DARK)).toBeGreaterThanOrEqual(
      WCAG_AA_TEXT,
    );
  });

  it(`light theme: text clears ${WCAG_AA_TEXT}:1 vs --inset (#f3f6f4) over all hues+chromas`, () => {
    const { textL } = LABEL_CHIP_THEME.light;
    const worst = worstCaseContrast(textL, ROW_BG_LIGHT);
     
    console.log(
      `[label-color] light worst-case: ratio=${worst.ratio.toFixed(3)} @ (hue=${worst.hue}, chroma=${worst.chroma.toFixed(4)})`,
    );
    expect(worst.ratio).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
    // explicit neutral (c=0) assertion — a grey label must also pass
    expect(contrastRatio(oklchToSrgb(textL, 0, 0), ROW_BG_LIGHT)).toBeGreaterThanOrEqual(
      WCAG_AA_TEXT,
    );
  });
});
