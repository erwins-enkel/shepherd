/** Reactive view of the `--ui-scale` custom property — the iOS Dynamic Type
 *  ratio the pre-paint probe in app.html resolves from `-apple-system-body`
 *  and writes as an INLINE STYLE on `<html>` (capped at 1.5 there). The CSS
 *  type scale consumes it via `calc(<px> * var(--ui-scale))`; this store is
 *  the JS-side counterpart for canvas-rendered text that CSS can't reach
 *  (the xterm terminal in Viewport.svelte).
 *
 *  Coupling contract: live updates arrive ONLY through the probe's
 *  `style.setProperty("--ui-scale", …)` writes, so a MutationObserver on the
 *  root element's `style` attribute is sufficient to see every change. The
 *  probe runs pre-paint — before any module script — so the constructor read
 *  already sees the final initial value. Everywhere the probe never runs
 *  (desktop, Android, SSR) the value stays 1 and terminal rendering is
 *  byte-identical to the unscaled behavior. */

function read(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

class UiScale {
  value = $state(1);

  constructor() {
    if (typeof document === "undefined") return; // SSR — stays 1
    this.value = read();
    new MutationObserver(() => {
      this.value = read();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
}

export const uiScale = new UiScale();
