// Shared pointer-drag lifecycle for the Repos modal + repository-sidebar
// resizers (issue #1787). Mirrors the Herd sidebar splitter: best-effort pointer
// capture, a drag threshold, live onDrag on qualifying moves, commit on
// pointer-up after a real drag, and a manual double-click detector (two
// threshold-less clicks within DBLCLICK_MS) that fires onReset. Extracted so the
// modal (2-D corner) and sidebar (1-D divider) share one implementation instead
// of near-identical clones.

const THRESHOLD = 3;
const DBLCLICK_MS = 400;

export interface ResizeDragOptions<C> {
  /** Runs at pointer-down: apply caller guards (return null to abort the drag)
   *  and capture the per-drag start geometry into a context passed back to onDrag. */
  onStart: (e: PointerEvent) => C | null;
  /** Called on each qualifying move with the live event + the start context. */
  onDrag: (e: PointerEvent, ctx: C) => void;
  /** Called on pointer-up after a real drag (moved past THRESHOLD). */
  onCommit: () => void;
  /** Called on a double-click with no drag between the two clicks. */
  onReset: () => void;
  /** Toggled true on drag start, false on drag end — drives the .dragging class. */
  onActive: (active: boolean) => void;
  /** Threshold axis: "x" for the 1-D divider, "both" for the 2-D corner grip. */
  axis: "x" | "both";
}

/** Build a pointerdown handler. The returned closure keeps the per-handle
 *  double-click timestamp between invocations. */
export function createResizeDrag<C>(opts: ResizeDragOptions<C>) {
  let lastClickTs = 0;

  return function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const ctx = opts.onStart(e);
    if (ctx === null) return; // caller guard rejected (not resizable / no refs)
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    // Best-effort: a synthetic (untrusted) pointer has no active capture target
    // and throws — moves still route via the handle's own listeners.
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer (e.g. synthetic events in tests) */
    }

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        const past =
          Math.abs(ev.clientX - startX) >= THRESHOLD ||
          (opts.axis === "both" && Math.abs(ev.clientY - startY) >= THRESHOLD);
        if (!past) return;
        moved = true;
        opts.onActive(true);
      }
      opts.onDrag(ev, ctx);
    };
    const onUp = (ev: PointerEvent) => {
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* capture never taken */
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      if (moved) {
        opts.onActive(false);
        opts.onCommit();
        lastClickTs = 0; // a drag isn't a click
        return;
      }
      // No drag → treat as a click; two within the window reset to default.
      if (lastClickTs && ev.timeStamp - lastClickTs < DBLCLICK_MS) {
        opts.onReset();
        lastClickTs = 0;
      } else {
        lastClickTs = ev.timeStamp;
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };
}
