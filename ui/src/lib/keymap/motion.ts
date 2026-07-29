// Motion for the hold-to-reveal layer.
//
// The scrim and the keycaps mount and unmount together, so their fade needs a
// real enter AND exit — a CSS transition can only drive the enter of an element
// that is being created. Hence Svelte transition factories, which is also why
// the spec's easing has to exist in JS: Svelte samples the `css` callback into
// a linear keyframe track, so the curve must already be baked into `t`.
//
// Timings and curve are the handoff's, verbatim:
//   in  120 ms, opacity 0→1 + translateY(-2px)→0
//   out  80 ms, opacity only
//   cubic-bezier(0.2, 0.8, 0.3, 1)
// Only opacity and transform are animated, so this stays on the compositor.

import type { TransitionConfig } from "svelte/transition";

// Svelte calls a transition as (node, params). Every value here is fixed by the
// spec, so none of them read the node — declaring the parameter on the TYPE and
// omitting it in the implementation keeps the call signature Svelte expects
// without carrying an unused binding.
type Reveal = (node: Element) => TransitionConfig;

const REVEAL_IN_MS = 120;
const REVEAL_OUT_MS = 80;

/** Solve a CSS cubic-bezier(x1, y1, x2, y2) for y at a given x.
 *
 *  Newton-Raphson with a bisection fallback — the same approach browsers use.
 *  Written out rather than approximated with svelte/easing's cubicOut, because
 *  the reveal is the one place the design pins an exact curve, and "close
 *  enough" easing is exactly the kind of drift the design system exists to
 *  stop. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // Newton stalled (flat slope) — fall back to bisection.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i += 1) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const ease = cubicBezier(0.2, 0.8, 0.3, 1);

function reducedMotion(): boolean {
  return (
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Keycaps: lift in, fade out. Stagger is deliberately zero — the handoff calls
 *  staggered caps a gimmick that slows down reading, and it's right. */
export const revealIn: Reveal = () => {
  if (reducedMotion()) return { duration: 0 };
  return {
    duration: REVEAL_IN_MS,
    easing: ease,
    css: (t) => `opacity: ${t}; transform: translateY(${(t - 1) * 2}px)`,
  };
};

export const revealOut: Reveal = () => {
  if (reducedMotion()) return { duration: 0 };
  return { duration: REVEAL_OUT_MS, easing: ease, css: (t) => `opacity: ${t}` };
};

/** The scrim: opacity only, both ways. */
export const scrimIn: Reveal = () => {
  if (reducedMotion()) return { duration: 0 };
  return { duration: REVEAL_IN_MS, easing: ease, css: (t) => `opacity: ${t}` };
};

export const scrimOut: Reveal = () => {
  if (reducedMotion()) return { duration: 0 };
  return { duration: REVEAL_OUT_MS, easing: ease, css: (t) => `opacity: ${t}` };
};
