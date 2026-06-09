// Svelte action: fire on a stationary touch long-press. Touch devices (iOS Safari
// especially) don't reliably emit a `contextmenu` event on long-press, so the card
// context menu can't rely on it — this fills that gap. A finger that moves past the
// tolerance (a scroll or swipe) cancels, so it never steals those gestures.
//
// `onTrigger` returns whether it actually opened something; only then do we
// suppress the trailing synthetic click (via preventDefault on touchend) so a plain
// tap on a card that has no menu still selects normally.

export type LongPressOpts = {
  onTrigger: (x: number, y: number) => boolean;
  ms?: number;
  moveTol?: number;
};

export function longPress(node: HTMLElement, opts: LongPressOpts) {
  let o = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  function reset() {
    clearTimeout(timer);
    timer = undefined;
    start = null;
  }
  function down(e: TouchEvent) {
    if (e.touches.length !== 1) return; // ignore multi-touch (pinch/zoom)
    fired = false;
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!start) return;
      const { x, y } = start;
      reset();
      fired = o.onTrigger(x, y);
      if (fired) navigator.vibrate?.(8); // a small haptic confirms the menu (no-op on iOS)
    }, o.ms ?? 500);
  }
  function move(e: TouchEvent) {
    if (!start || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > (o.moveTol ?? 10)) reset();
  }
  function end(e: TouchEvent) {
    if (fired) e.preventDefault(); // cancel the synthetic click so it doesn't also select
    reset();
  }

  node.addEventListener("touchstart", down, { passive: true });
  node.addEventListener("touchmove", move, { passive: true });
  node.addEventListener("touchend", end); // non-passive: may preventDefault
  node.addEventListener("touchcancel", reset);

  return {
    update(next: LongPressOpts) {
      o = next;
    },
    destroy() {
      reset();
      node.removeEventListener("touchstart", down);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", reset);
    },
  };
}
