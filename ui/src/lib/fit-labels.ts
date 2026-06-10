// Space-adaptive labels: a Svelte action that toggles a `compact` class on its
// container when the full-label rendering would overflow horizontally. The
// container's CSS decides what "compact" means (typically: hide the text label on
// buttons that carry an emoji, leaving the emoji as the identifier).
//
// Mirrors TopBar's measured-compaction strategy: the full-label content width is
// RESIZE-INVARIANT (nothing wraps on container width), so it is measured ONCE per
// content change — render full, read scrollWidth in the next frame, cache it — and
// a pure resize only compares the cached width against the new clientWidth. No
// reset-to-full per resize tick means no flicker and no ResizeObserver feedback
// loop (the RO callback never mutates layout except across the threshold).
export function fitLabels(node: HTMLElement) {
  // Cached full-label content width; 0 = unknown/stale (must re-measure).
  let fullWidth = 0;
  let raf = 0;

  // 1px slack absorbs sub-pixel layout rounding, so flush-fitting full labels
  // (scrollWidth a hair over clientWidth) aren't needlessly compacted.
  const decide = () => node.classList.toggle("compact", fullWidth > node.clientWidth + 1);

  // Content changed: render full so scrollWidth IS the full-label width, then
  // read + cache it next frame and decide compaction.
  const measureFull = () => {
    if (raf) return;
    node.classList.remove("compact");
    raf = requestAnimationFrame(() => {
      raf = 0;
      fullWidth = node.scrollWidth;
      decide();
    });
  };

  const ro = new ResizeObserver(() => {
    if (fullWidth > 0) decide();
    else measureFull();
  });
  ro.observe(node);
  const mo = new MutationObserver(() => {
    fullWidth = 0; // content changed → cached full width is stale
    measureFull();
  });
  // No `attributes`: our own class flips must not re-trigger measurement.
  mo.observe(node, { childList: true, subtree: true, characterData: true });
  measureFull();

  return {
    destroy() {
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
