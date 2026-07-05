// Pure geometry for the two high-fidelity capture modes. The chrome
// orchestration (captureVisibleTab loop, OffscreenCanvas draw) lives in
// background.ts; only the math that decides *where* to scroll/crop lives here so
// it can be unit-tested without a browser.

/** A device-pixel crop window into a captureVisibleTab PNG (canvas drawImage source rect). */
export interface CropRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** An element's viewport-relative CSS rect (getBoundingClientRect subset). */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Plan for stitching a full-page screenshot from viewport-height slices. */
export interface StitchPlan {
  /** Scroll-Y offsets (CSS px) to capture, top to bottom. */
  steps: number[];
  /** CSS height actually covered by the captured slices (= stitched canvas height / dpr). */
  coveredHeight: number;
  /** True when the page exceeded `maxTiles` and the bottom was left uncaptured. */
  truncated: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Compute the scroll offsets to capture a `pageHeight`-tall page in
 * `viewportHeight` slices. The final slice is clamped to the page bottom
 * (`pageHeight - viewportHeight`) so the last tile aligns with the bottom edge;
 * the resulting overlap with the previous tile is harmless (overwritten when
 * drawn at its true offset). Bounded by `maxTiles`: a taller page is captured up
 * to that many slices and reports `truncated` so the popup can say so rather than
 * silently dropping the bottom of the page.
 */
export function computeStitchPlan({
  pageHeight,
  viewportHeight,
  maxTiles,
}: {
  pageHeight: number;
  viewportHeight: number;
  maxTiles: number;
}): StitchPlan {
  // A non-positive/non-finite viewport can't be sliced — fall back to one visible capture.
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0 || pageHeight <= viewportHeight) {
    return { steps: [0], coveredHeight: Math.max(0, pageHeight), truncated: false };
  }

  const needed = Math.ceil(pageHeight / viewportHeight);
  const tiles = Math.min(needed, maxTiles);
  const truncated = needed > maxTiles;

  const steps: number[] = [];
  for (let i = 0; i < tiles; i++) {
    // Clamp the last slice to the page bottom only when we actually reach it.
    const isLast = i === tiles - 1 && !truncated;
    steps.push(isLast ? Math.max(0, pageHeight - viewportHeight) : i * viewportHeight);
  }

  const coveredHeight = truncated ? tiles * viewportHeight : pageHeight;
  return { steps, coveredHeight, truncated };
}

/**
 * Clamp an element's viewport-relative CSS rect to the visible viewport and scale
 * to device pixels, yielding the source crop window for the captured PNG. Returns
 * `null` when the clamped region has zero area (element fully offscreen or
 * collapsed) so the caller can fall back to the full visible capture.
 */
export function cropRegionForElement(
  rect: ElementRect,
  viewport: { width: number; height: number },
  dpr: number,
): CropRegion | null {
  const left = clamp(rect.x, 0, viewport.width);
  const top = clamp(rect.y, 0, viewport.height);
  const right = clamp(rect.x + rect.width, 0, viewport.width);
  const bottom = clamp(rect.y + rect.height, 0, viewport.height);

  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;

  return {
    sx: Math.round(left * dpr),
    sy: Math.round(top * dpr),
    sw: Math.round(w * dpr),
    sh: Math.round(h * dpr),
  };
}

/**
 * Crop window for a marquee (user-dragged rectangle) capture. The geometry is
 * intentionally identical to `cropRegionForElement` — a marquee rect is just
 * another viewport-relative CSS rect (already normalized to positive width/height
 * by the overlay) that gets clamped to the viewport and scaled to device pixels,
 * `null` on zero area. Kept as a named delegate (not a call-site reuse) so the
 * marquee capture path reads honestly and can diverge later without touching the
 * element path. A `null` here means the caller must abort the pick (not fall back
 * to a full-viewport capture, as element mode does).
 */
export function cropRegionForMarquee(
  rect: ElementRect,
  viewport: { width: number; height: number },
  dpr: number,
): CropRegion | null {
  return cropRegionForElement(rect, viewport, dpr);
}
