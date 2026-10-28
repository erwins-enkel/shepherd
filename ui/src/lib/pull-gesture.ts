// Phone herd list pull-down gesture: a short pull opens the command bar, a longer one
// reloads the page. Pure math only — the touch wiring lives in actions/pullToCommand.ts.

export type PullStage = "idle" | "search" | "reload";

/** Resisted distance (px) at which releasing opens the command bar. */
export const PULL_SEARCH = 64;
/** Resisted distance (px) at which releasing reloads the page. */
export const PULL_RELOAD = 144;
/** Raw finger travel (px) before a pull counts as one, so taps and jitter never arm it. */
export const PULL_SLOP = 8;

// Rubber-band damping: ~2:3 for a short pull, flattening toward MAX for a long one.
const MAX = 260;

export function resist(dy: number): number {
  if (dy <= 0) return 0;
  return MAX * (1 - Math.exp(-dy / (MAX * 1.5)));
}

export function pullStage(distance: number): PullStage {
  if (distance >= PULL_RELOAD) return "reload";
  if (distance >= PULL_SEARCH) return "search";
  return "idle";
}

/** Whether a touch move should become a pull: page at the top, mostly vertical, downward. */
export function shouldArm({
  scrollY,
  dx,
  dy,
}: {
  scrollY: number;
  dx: number;
  dy: number;
}): boolean {
  return scrollY <= 0 && dy > PULL_SLOP && Math.abs(dy) > Math.abs(dx);
}
