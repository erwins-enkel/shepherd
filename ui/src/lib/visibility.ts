/**
 * Drive a network poller only while the tab is visible: interval ticks are
 * skipped while `document.hidden` (a backgrounded HUD shouldn't keep hitting
 * the server), and returning to the tab fires an immediate `fn()` so the
 * operator sees fresh data instead of up-to-one-interval-stale data.
 *
 * The caller performs its own initial load (some pollers tick conditionally);
 * this only owns the recurring cadence. Returns a disposer.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
  const timer = setInterval(() => {
    if (!document.hidden) fn();
  }, ms);
  const onVisibility = () => {
    if (!document.hidden) fn();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Run `fn` whenever the operator comes back to the page: the tab turns visible again, or iOS
 * Safari restores it from the bfcache (`pageshow` with `persisted`, which doesn't always fire
 * visibilitychange). Returns a disposer.
 */
export function onPageReturn(fn: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") fn();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) fn();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
  };
}
