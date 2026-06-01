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

/** Clamp a raw horizontal offset to the left-only reveal range [-reveal, 0]. */
export function clampOffset(px: number, reveal: number = REVEAL_PX): number {
  if (px > 0) return 0;
  if (px < -reveal) return -reveal;
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

/** Callbacks a host component supplies to drive the swipe action. */
export interface SwipeCallbacks {
  /** Current slid offset (px, negative = open). */
  current: () => number;
  /** Live offset during a horizontal drag. */
  onOffset: (px: number) => void;
  /** Toggled while a horizontal drag is in progress (host suppresses the snap transition). */
  onDragging: (dragging: boolean) => void;
  /** Finger lifted after a horizontal drag — host snaps open or closed. */
  onRelease: () => void;
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
      cb.onOffset(clampOffset(startOffset + dx));
    }
  }
  function up(e: PointerEvent) {
    if (pid !== e.pointerId) return;
    if (axis === "x") cb.onRelease();
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
