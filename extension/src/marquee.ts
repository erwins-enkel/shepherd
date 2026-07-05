// Marquee (drag-rectangle) overlay, injected on demand (isolated world) when the
// user chooses "Select region…" in the popup. The user drags a box over the page;
// on release its viewport-relative bounds are sent to the background worker, which
// captures the visible tab and crops to those bounds. Esc / right-click / a
// sub-threshold drag cancels. Idempotent across re-injection.
//
// Mirrors src/picker.ts (element mode), but draws a free-form rectangle instead of
// snapping to a DOM node. The instruction label is resolved in the popup (its
// locale) and handed in via `window.__shepherdMarqueeLabel`, so this script stays
// tiny and needn't bundle Paraglide.
import type { PickerMessage } from "./lib/types";

declare global {
  interface Window {
    __shepherdMarquee?: boolean;
    __shepherdMarqueeLabel?: string;
  }
}

(() => {
  if (window.__shepherdMarquee) return;
  window.__shepherdMarquee = true;

  const Z = 2147483646; // just under max so nothing the page draws sits above the overlay
  const MIN = 8; // CSS px: a smaller drag is treated as an accidental click (cancel)
  const root = document.documentElement;

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const DIM = "rgba(0, 0, 0, 0.4)";

  // Event catcher: full-viewport, crosshair. Dims the whole page on activation so
  // the capture mode reads immediately (before any drag). Receives the drag
  // directly (unlike the picker, which listens on `document`) so the gesture never
  // selects page text or activates page elements. On mousedown its dim is dropped
  // and the selection's spotlight takes over, so the two never double-dim.
  const catcher = document.createElement("div");
  Object.assign(catcher.style, {
    position: "fixed",
    inset: "0",
    zIndex: String(Z + 1),
    cursor: "crosshair",
    background: DIM,
    userSelect: "none",
  } as Partial<CSSStyleDeclaration>);

  // Selection rectangle. Its huge spread box-shadow dims everything *outside* the
  // rect (a "spotlight"), keeping the selected region clear — it replaces the
  // catcher's flat dim once a drag begins. pointer-events:none so it never
  // intercepts the drag.
  const sel = document.createElement("div");
  Object.assign(sel.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: String(Z),
    boxSizing: "border-box",
    border: "2px solid #2563eb",
    background: "rgba(37, 99, 235, 0.12)",
    boxShadow: `0 0 0 9999px ${DIM}`,
    top: "0",
    left: "0",
    display: "none",
  } as Partial<CSSStyleDeclaration>);

  const bar = document.createElement("div");
  bar.textContent = window.__shepherdMarqueeLabel ?? "";
  Object.assign(bar.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: String(Z + 2),
    bottom: "16px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#111827",
    color: "#ffffff",
    font: "13px/1.4 system-ui, -apple-system, sans-serif",
    padding: "8px 14px",
    borderRadius: "8px",
    boxShadow: "0 4px 14px rgba(0, 0, 0, 0.3)",
    maxWidth: "90vw",
  } as Partial<CSSStyleDeclaration>);

  root.appendChild(sel);
  root.appendChild(catcher);
  root.appendChild(bar);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function send(msg: PickerMessage): void {
    chrome.runtime.sendMessage(msg);
  }

  function teardown(): void {
    window.__shepherdMarquee = undefined;
    sel.remove();
    catcher.remove();
    bar.remove();
    catcher.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onUp, true);
    document.removeEventListener("keydown", onKey, true);
    catcher.removeEventListener("contextmenu", onContext, true);
  }

  function cancel(): void {
    send({ type: "marquee-cancel" });
    teardown();
  }

  /** Normalize origin→cursor into a positive-dimension rect, clamped to the viewport. */
  function rectFrom(e: MouseEvent): { left: number; top: number; width: number; height: number } {
    const x = clamp(e.clientX, 0, window.innerWidth);
    const y = clamp(e.clientY, 0, window.innerHeight);
    return {
      left: Math.min(startX, x),
      top: Math.min(startY, y),
      width: Math.abs(x - startX),
      height: Math.abs(y - startY),
    };
  }

  function onDown(e: MouseEvent): void {
    if (e.button !== 0) return; // left-drag only; right-click cancels via onContext
    e.preventDefault();
    dragging = true;
    startX = clamp(e.clientX, 0, window.innerWidth);
    startY = clamp(e.clientY, 0, window.innerHeight);
    // Hand the dim off to the selection's spotlight so the two don't stack.
    catcher.style.background = "transparent";
    Object.assign(sel.style, {
      display: "block",
      left: `${startX}px`,
      top: `${startY}px`,
      width: "0px",
      height: "0px",
    });
  }

  function onMove(e: MouseEvent): void {
    if (!dragging) return;
    const r = rectFrom(e);
    Object.assign(sel.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function onUp(e: MouseEvent): void {
    if (!dragging) return;
    dragging = false;
    const r = rectFrom(e);

    // `mouseup` synthesizes a `click` that could activate the page (follow a link,
    // submit a form) once the overlay is gone — swallow it once, capture-phase.
    document.addEventListener(
      "click",
      (ev) => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      },
      { capture: true, once: true },
    );

    if (r.width < MIN || r.height < MIN) {
      cancel();
      return;
    }

    const pick: PickerMessage = {
      type: "marquee-pick",
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio || 1,
    };
    // Tear the overlay down first, then defer the message two frames so the
    // selection/dim have actually painted out before the worker captures the tab —
    // otherwise the spotlight could bleed into the cropped screenshot.
    teardown();
    requestAnimationFrame(() => requestAnimationFrame(() => send(pick)));
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  function onContext(e: MouseEvent): void {
    e.preventDefault();
    cancel();
  }

  catcher.addEventListener("mousedown", onDown, true);
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  document.addEventListener("keydown", onKey, true);
  catcher.addEventListener("contextmenu", onContext, true);
})();
