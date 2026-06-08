// Element-picker overlay, injected on demand (isolated world) when the user
// chooses "Pick element" in the popup. Highlights the element under the cursor
// and, on click, sends its viewport-relative bounds to the background worker,
// which captures the visible tab and crops to those bounds. Esc / right-click
// cancels. Idempotent across re-injection.
//
// The instruction label is resolved in the popup (its locale) and handed in via
// `window.__shepherdPickerLabel` (set by a prior isolated-world injection), so
// this script stays tiny and needn't bundle Paraglide.
import type { PickerMessage } from "./lib/types";

declare global {
  interface Window {
    __shepherdPicker?: boolean;
    __shepherdPickerLabel?: string;
  }
}

(() => {
  if (window.__shepherdPicker) return;
  window.__shepherdPicker = true;

  const Z = 2147483646; // just under max so nothing the page draws sits above the overlay
  const root = document.documentElement;

  const outline = document.createElement("div");
  Object.assign(outline.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: String(Z),
    boxSizing: "border-box",
    border: "2px solid #2563eb",
    background: "rgba(37, 99, 235, 0.12)",
    borderRadius: "2px",
    top: "0",
    left: "0",
    display: "none",
  } as Partial<CSSStyleDeclaration>);

  const bar = document.createElement("div");
  bar.textContent = window.__shepherdPickerLabel ?? "";
  Object.assign(bar.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: String(Z + 1),
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

  root.appendChild(outline);
  root.appendChild(bar);

  let current: Element | null = null;

  function send(msg: PickerMessage): void {
    chrome.runtime.sendMessage(msg);
  }

  function teardown(): void {
    window.__shepherdPicker = undefined;
    outline.remove();
    bar.remove();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("contextmenu", onContext, true);
  }

  function cancel(): void {
    send({ type: "picker-cancel" });
    teardown();
  }

  function onMove(e: MouseEvent): void {
    const el = e.target as Element | null;
    if (!el || el === current) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, {
      display: "block",
      top: `${r.top}px`,
      left: `${r.left}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function onClick(e: MouseEvent): void {
    // Capture-phase + prevent default/propagation so the click selects rather than
    // activating the page (following a link, submitting a form, …).
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = current ?? (e.target as Element | null);
    if (!el) {
      cancel();
      return;
    }
    const r = el.getBoundingClientRect();
    send({
      type: "picker-pick",
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio || 1,
    });
    teardown();
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

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("contextmenu", onContext, true);
})();
