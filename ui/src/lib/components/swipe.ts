/**
 * Pure state machine for the mobile session-list swipe-to-decommission gesture.
 * Kept framework-free so it can be unit-tested without a DOM; UnitRow.svelte owns
 * the pointer wiring, transform, and timers.
 */

/** Width of the revealed decommission action, in px. */
export const REVEAL_PX = 104;
/** Movement (px) before the gesture commits to an axis. */
const SLOP_PX = 10;
/** Fraction of REVEAL_PX past which a release snaps the row open. */
export const OPEN_RATIO = 0.4;

export type Axis = "x" | "y" | null;

/**
 * Lock the gesture axis once movement exceeds slop; null until then.
 * Ties favour "y" so an ambiguous diagonal lets the list keep scrolling.
 */
export function lockAxis(dx: number, dy: number, slop: number = SLOP_PX): Axis {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

/** Clamp a raw horizontal offset to the left-only range [-max, 0]. */
export function clampOffset(px: number, max: number = REVEAL_PX): number {
  if (px > 0) return 0;
  if (px < -max) return -max;
  return px;
}

/** Target offset after release: snap open past the ratio, else closed. */
export function snapOffset(
  offset: number,
  reveal: number = REVEAL_PX,
  ratio: number = OPEN_RATIO,
): number {
  return offset <= -reveal * ratio ? -reveal : 0;
}

/** Fraction of the row width past which a release decommissions outright (full swipe). */
export const FULL_SWIPE_RATIO = 0.6;
/** The full-swipe threshold never sits closer than this to the reveal width. */
const FULL_SWIPE_MIN_GAP = 40;

/** Leftward travel (px, positive) past which a release decommissions the row. */
export function fullSwipeThreshold(
  rowWidth: number,
  reveal: number = REVEAL_PX,
  ratio: number = FULL_SWIPE_RATIO,
): number {
  return Math.max(rowWidth * ratio, reveal + FULL_SWIPE_MIN_GAP);
}

/** What a released row swipe does: decommission (full), snap open, or close. */
export type RowReleaseOutcome = "full" | "open" | "closed";

/**
 * A cancelled gesture (pointercancel: OS/UA took the touch) only settles open or
 * closed — it never decommissions, since the user didn't release into it.
 */
export function releaseOutcome(
  offset: number,
  rowWidth: number,
  cancelled: boolean = false,
): RowReleaseOutcome {
  if (!cancelled && offset <= -fullSwipeThreshold(rowWidth)) return "full";
  return snapOffset(offset) === -REVEAL_PX ? "open" : "closed";
}

/** Commit decision for a released horizontal pane swipe (Viewport). */
export type PaneSwipeOutcome = "back" | "next" | "none";

/** Pane-swipe tuning, copied from the iOS app's IOSSteerSwipe so both feel alike. */
export const PANE_SWIPE_THRESHOLD = 90; // px past which a release commits
export const PANE_FLICK_VELOCITY = 700; // px/s that commits a shorter flick…
const PANE_FLICK_MIN = 30; // …once it has travelled at least this far
const PANE_SOFT_LIMIT = 140; // px beyond which the pane follows with resistance
const PANE_DAMPING = 0.35;

/**
 * Resolve a released horizontal pane swipe. Mirrors the iOS app: rightward always
 * returns to the session list, leftward pages to the next agent. Commits past
 * `threshold`, or earlier on a fast flick moving the same way as the drag.
 * `canBack` / `canNext` say whether each direction has somewhere to go.
 */
export function paneSwipeOutcome(
  dx: number,
  velocity: number,
  threshold: number,
  canBack: boolean,
  canNext: boolean,
): PaneSwipeOutcome {
  const flick =
    Math.abs(velocity) >= PANE_FLICK_VELOCITY &&
    Math.abs(dx) >= PANE_FLICK_MIN &&
    velocity < 0 === dx < 0;
  if (Math.abs(dx) < threshold && !flick) return "none";
  if (dx > 0) return canBack ? "back" : "none";
  return canNext ? "next" : "none";
}

/** Rubber-band a drag offset: 1:1 up to the soft limit, damped past it, sign kept. */
export function resistOffset(dx: number, softLimit: number = PANE_SOFT_LIMIT): number {
  const magnitude = Math.abs(dx);
  if (magnitude <= softLimit) return dx;
  const damped = softLimit + (magnitude - softLimit) * PANE_DAMPING;
  return dx < 0 ? -damped : damped;
}

/**
 * Whether a released gesture is a deliberate upward swipe — used by the ctrl-row
 * to summon the compose sheet. Requires clearing `threshold` upward (dy negative)
 * AND being more vertical than horizontal, so a horizontal pane swipe or a small
 * tap on a chip never triggers it.
 */
export function isSwipeUp(dx: number, dy: number, threshold: number): boolean {
  return dy <= -threshold && Math.abs(dy) > Math.abs(dx);
}

/** Callbacks a host component supplies to drive the swipe action. */
export interface SwipeCallbacks {
  /** Current slid offset (px, negative = open). */
  current: () => number;
  /** Maximum leftward travel (px, positive) for the drag in progress. */
  maxOffset: () => number;
  /** Live offset during a horizontal drag. */
  onOffset: (px: number) => void;
  /** Toggled while a horizontal drag is in progress (host suppresses the snap transition). */
  onDragging: (dragging: boolean) => void;
  /** Finger lifted (or pointer cancelled) after a horizontal drag — host settles the row. */
  onRelease: (cancelled: boolean) => void;
  /** Host should close an open row (tapped while open). */
  requestClose: () => void;
}

/**
 * Svelte action: left-swipe gesture on a row. Owns pointer tracking and the
 * capture-phase click that swallows the row's select tap after a drag or while
 * open. Kept off the markup as inline handlers so static-element a11y rules
 * stay satisfied — the real interactive elements are the inner buttons.
 */
export function swipeGesture(node: HTMLElement, callbacks: SwipeCallbacks) {
  let cb = callbacks;
  let axis: Axis = null;
  let pid: number | null = null;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;
  let dragged = false; // a horizontal drag occurred in the current pointer sequence

  function down(e: PointerEvent) {
    pid = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startOffset = cb.current();
    axis = null;
    dragged = false;
  }
  function move(e: PointerEvent) {
    if (pid !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (axis === null) {
      axis = lockAxis(dx, dy);
      if (axis === "x") {
        dragged = true;
        cb.onDragging(true);
        node.setPointerCapture(pid);
      }
    }
    if (axis === "x") {
      e.preventDefault();
      cb.onOffset(clampOffset(startOffset + dx, cb.maxOffset()));
    }
  }
  function up(e: PointerEvent) {
    if (pid !== e.pointerId) return;
    if (axis === "x") cb.onRelease(e.type === "pointercancel");
    cb.onDragging(false);
    axis = null;
    pid = null;
  }
  function clickCapture(e: MouseEvent) {
    const open = cb.current() !== 0;
    if (dragged || open) {
      e.preventDefault();
      e.stopPropagation();
      dragged = false;
      if (open) cb.requestClose();
    }
  }

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);
  node.addEventListener("click", clickCapture, true);

  return {
    update(next: SwipeCallbacks) {
      cb = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      node.removeEventListener("click", clickCapture, true);
    },
  };
}

export type DecomState = "idle" | "armed";

/**
 * Two-step arm/confirm press (mirrors Viewport's decommission). First press arms;
 * a second press while armed fires the action and resets.
 */
export function pressDecom(state: DecomState): { state: DecomState; fire: boolean } {
  return state === "armed" ? { state: "idle", fire: true } : { state: "armed", fire: false };
}
