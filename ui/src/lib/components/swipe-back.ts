import type { Attachment } from "svelte/attachments";
import { lockAxis, paneSwipeOutcome, resistOffset, PANE_SWIPE_THRESHOLD, type Axis } from "./swipe";

/**
 * Phone: a rightward swipe over a detail pane goes back, like the session viewport and iOS
 * back. The pane follows the finger (`onoffset`, rubber-banded px ≥ 0); a release past the
 * threshold (or a flick) calls `onback`. Vertical and leftward drags, and drags from text
 * fields or sideways-scrolling content (flow graph, wide code), stay native. Nested roots
 * (an issue detail inside the repo detail) go innermost first: each root only takes touches
 * whose nearest `[data-swipe-back]` is itself.
 */
export function swipeBack(opts: {
  onback: () => void;
  onoffset: (px: number) => void;
}): Attachment<HTMLElement> {
  return (root) => {
    root.dataset.swipeBack = "";
    let startX = 0;
    let startY = 0;
    let armed = false;
    let axis: Axis = null;
    let locked = false;
    let dx = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0; // px/s, from the last two touchmove samples
    let past = false; // past the commit threshold (haptic tick once on crossing)
    const threshold = () => Math.min(PANE_SWIPE_THRESHOLD, root.clientWidth * 0.33);
    const scrollsSideways = (from: Element) => {
      for (let n: Element | null = from; n && n !== root; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth) return true;
      }
      return false;
    };
    const onStart = (e: TouchEvent) => {
      armed = false;
      if (e.touches.length !== 1) return;
      const t = e.target as Element | null;
      if (!t || t.closest("input, textarea, select, [contenteditable], [data-swipe-ignore]"))
        return;
      if (t.closest("[data-swipe-back]") !== root) return;
      if (scrollsSideways(t)) return;
      startX = lastX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      lastT = e.timeStamp;
      armed = true;
      axis = null;
      locked = false;
      dx = 0;
      velocity = 0;
      past = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!armed || e.touches.length !== 1) return;
      const x = e.touches[0].clientX;
      dx = x - startX;
      if (e.timeStamp > lastT) velocity = ((x - lastX) / (e.timeStamp - lastT)) * 1000;
      lastX = x;
      lastT = e.timeStamp;
      if (!locked) {
        if (axis === null) axis = lockAxis(dx, e.touches[0].clientY - startY);
        if (axis === null) return; // still within slop
        if (axis !== "x" || dx <= 0) {
          armed = false; // vertical scroll or leftward: not ours
          return;
        }
        locked = true;
      }
      e.preventDefault();
      opts.onoffset(resistOffset(Math.max(0, dx)));
      const nowPast = dx >= threshold();
      if (nowPast && !past) navigator.vibrate?.(8);
      past = nowPast;
    };
    const onEnd = (e: TouchEvent) => {
      if (locked) {
        // a finger that paused before lifting isn't flicking: drop the stale velocity
        if (e.timeStamp - lastT > 100) velocity = 0;
        const back = paneSwipeOutcome(dx, velocity, threshold(), true, false) === "back";
        opts.onoffset(0);
        if (back) opts.onback();
      }
      armed = false;
      locked = false;
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false, capture: true });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove, { capture: true });
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
      delete root.dataset.swipeBack;
      opts.onoffset(0);
    };
  };
}
