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
