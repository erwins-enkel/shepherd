import type { Action } from "svelte/action";
import { anchorPopover } from "$lib/floating-anchor";

export interface StatusTipParams {
  /** The explanation text shown in the tooltip and exposed to AT via aria-describedby. */
  text: string;
  /** Set false for actionable controls whose delegated click handler must run. */
  stopClickPropagation?: boolean;
  /** Suppress the entrance animation (motion-free surfaces like the New Task modal). */
  still?: boolean;
}

// Module-scoped counter for unique popover ids. Client-only (actions never run on
// the server), so a plain counter is safe — no SSR/hydration id collision concern.
let uid = 0;

/**
 * Explanation-only tooltip for the session-card status chips.
 *
 * Raises the trigger above the full-card `.unit-hit` overlay (inline
 * `position:relative; z-index:1`) so hover/tap reach the chip instead of the
 * overlay, and reveals a styled, **text-only** `role="tooltip"` popover:
 *  - hover (fine pointer) opens a transient tooltip; a genuine pointer click
 *    **pins** it so it survives `pointerleave` (a real affordance, not a fleeting
 *    hover) — dismissed by outside-click / Esc / scroll.
 *  - every open path is idempotent and `click` never toggles, so a touch tap's
 *    `focus`→`click` sequence can't flash it shut.
 * Click propagation is stopped by default so read-only chips never select their
 * row; actionable controls can opt out while retaining the same explanation.
 *
 * The explanation is exposed to assistive tech via `aria-description` (a string —
 * always valid, no dangling IDREF, present from mount), so screen readers announce
 * it in browse mode even though the chip is not a Tab stop. The *visual* popover is
 * created lazily on first open. Pass `null` to disable (callers gate with
 * `tip ? {...} : null`).
 */
export const statusTip: Action<HTMLElement, StatusTipParams | null | undefined> = (
  node,
  params,
) => {
  let pop: HTMLDivElement | null = null;
  let text = "";
  let stopClickPropagation = true;
  let still = false;
  let open = false;
  let pinned = false;
  let stopAnchor: (() => void) | null = null;
  let nodeListeners = false;

  // Create the *visual* popover lazily (only when first shown) so hidden tooltip
  // text never pollutes the DOM / text queries; AT reads `aria-description` instead.
  function ensurePopover() {
    if (pop) {
      pop.textContent = text;
      return;
    }
    pop = document.createElement("div");
    pop.id = `status-tip-${++uid}`;
    pop.className = still ? "status-tip status-tip-still" : "status-tip";
    pop.setAttribute("role", "tooltip");
    pop.setAttribute("popover", "manual");
    pop.textContent = text;
    document.body.appendChild(pop);
  }

  function onDocPointerDown(e: PointerEvent) {
    const t = e.target as Node;
    if (node.contains(t) || pop?.contains(t)) return;
    hide();
  }
  function onScrollOrResize() {
    hide();
  }

  function show() {
    if (open) return;
    ensurePopover();
    if (!pop) return;
    try {
      pop.showPopover();
    } catch {
      return; // not connected this tick
    }
    open = true;
    stopAnchor = anchorPopover(node, pop, 6);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
  }

  function hide() {
    pinned = false;
    if (!open) return;
    open = false;
    stopAnchor?.(); // stops autoUpdate + hidePopover()
    stopAnchor = null;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  }

  function onPointerEnter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    show();
  }
  function onPointerLeave(e: PointerEvent) {
    if (e.pointerType === "touch" || pinned) return;
    hide();
  }
  function onFocus() {
    show();
  }
  function onBlur() {
    hide();
  }
  function onClick(e: MouseEvent) {
    if (stopClickPropagation) e.stopPropagation(); // read-only chips never select the row
    show();
    if (e.detail > 0) pinned = true; // genuine pointer click pins; keyboard (detail 0) does not
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") hide();
  }

  function enable(next: StatusTipParams) {
    text = next.text;
    stopClickPropagation = next.stopClickPropagation ?? true;
    still = next.still ?? false;
    if (pop) pop.textContent = text;
    // Expose the explanation to assistive tech directly (no referenced element).
    node.setAttribute("aria-description", text);
    // Raise above the `.unit-hit` overlay. Only set position when the element is
    // otherwise static, so we never clobber a component's own positioning.
    if (!node.style.position) node.style.position = "relative";
    node.style.zIndex = "1";
    // A styled tooltip is the only tooltip path — strip any native title so they
    // can't double up on hover.
    node.removeAttribute("title");
    if (!nodeListeners) {
      nodeListeners = true;
      node.addEventListener("pointerenter", onPointerEnter);
      node.addEventListener("pointerleave", onPointerLeave);
      node.addEventListener("focus", onFocus);
      node.addEventListener("blur", onBlur);
      node.addEventListener("click", onClick);
      node.addEventListener("keydown", onKeydown);
    }
  }

  function teardown() {
    hide();
    if (nodeListeners) {
      nodeListeners = false;
      node.removeEventListener("pointerenter", onPointerEnter);
      node.removeEventListener("pointerleave", onPointerLeave);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", onBlur);
      node.removeEventListener("click", onClick);
      node.removeEventListener("keydown", onKeydown);
    }
    if (pop) {
      pop.remove();
      pop = null;
    }
    node.removeAttribute("aria-description");
    node.style.zIndex = "";
  }

  if (params?.text) enable(params);

  return {
    update(next: StatusTipParams | null | undefined) {
      if (next?.text) enable(next);
      else teardown();
    },
    destroy() {
      teardown();
    },
  };
};
