// Svelte action — a phone pull-down gesture (see #lib/pull-gesture): the herd list's
// (command bar / reload) and New Task's (repo picker, no reload stage).
// Once a pull arms, every touchmove is preventDefault'ed so the browser's own
// pull-to-refresh / rubber band never runs alongside it: iOS Safari does not
// reliably honor overscroll-behavior for that (WebKit bug 275947).

import { pullStage, resist, shouldArm, type PullStage } from "#lib/pull-gesture.js";

export interface PullToCommandOptions {
  /** Read at touchstart: false (an overlay or sheet is open) ignores the whole touch. */
  enabled: () => boolean;
  /** Live stage + resisted distance while pulling; ("idle", 0) when the pull ends. */
  onstage: (stage: PullStage, distance: number) => void;
  /** Release in the first stage: the herd list opens the command bar, New Task the repo picker. */
  onsearch: () => void;
  /** Release in the long stage. Absent: there is no long stage, a long pull still searches. */
  onreload?: () => void;
  /** Scroll offset that must be 0 to arm. Default window.scrollY; a fixed overlay passes 0. */
  scrollTop?: () => number;
}

// A nested scroller that is itself scrolled down owns the pull: scrolling it back up wins.
function inScrolledRegion(target: EventTarget | null, root: HTMLElement): boolean {
  for (
    let el = target instanceof Element ? target : null;
    el && el !== root;
    el = el.parentElement
  ) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

export function pullToCommand(node: HTMLElement, initial: PullToCommandOptions) {
  let opts = initial;
  let start: { x: number; y: number } | null = null;
  let armed = false;
  let distance = 0;

  function reset() {
    if (armed) opts.onstage("idle", 0);
    start = null;
    armed = false;
    distance = 0;
  }

  function onStart(e: TouchEvent) {
    reset();
    if (e.touches.length !== 1 || !opts.enabled() || inScrolledRegion(e.target, node)) return;
    // A drag in a field moves its caret/selection, never a pull.
    if (
      e.target instanceof Element &&
      e.target.closest("input, textarea, select, [contenteditable]")
    )
      return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }

  function track(dx: number, dy: number) {
    if (!armed) armed = shouldArm({ scrollY: opts.scrollTop?.() ?? window.scrollY, dx, dy });
    if (!armed) return;
    distance = resist(dy);
    opts.onstage(pullStage(distance, !!opts.onreload), distance);
  }

  function onMove(e: TouchEvent) {
    if (!start) return;
    if (e.touches.length !== 1) return reset();
    const t = e.touches[0];
    track(t.clientX - start.x, t.clientY - start.y);
    if (armed && e.cancelable) e.preventDefault();
  }

  function onEnd() {
    const stage = armed ? pullStage(distance, !!opts.onreload) : "idle";
    reset();
    if (stage === "search") opts.onsearch();
    else if (stage === "reload") opts.onreload?.();
  }

  node.addEventListener("touchstart", onStart, { passive: true });
  node.addEventListener("touchmove", onMove, { passive: false });
  node.addEventListener("touchend", onEnd);
  node.addEventListener("touchcancel", reset);

  return {
    update(next: PullToCommandOptions) {
      opts = next;
    },
    destroy() {
      reset();
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", reset);
    },
  };
}
