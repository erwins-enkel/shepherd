import type { Action } from "svelte/action";
import { anchorPopover } from "$lib/floating-anchor";

export interface StatusTipParams {
  /** The explanation text shown in the tooltip and exposed to AT via aria-describedby. */
  text: string;
  /** Set false for actionable controls whose delegated click handler must run. */
  stopClickPropagation?: boolean;
  /** Suppress the entrance animation (motion-free surfaces like the New Task modal). */
  still?: boolean;
  /**
   * Widen the panel for multi-sentence prose. The default 260px is sized for the
   * one-or-two-line status explanations; a command description runs several hundred
   * characters and would otherwise stack into a ~20-line column.
   */
  wide?: boolean;
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
  let wide = false;
  let open = false;
  let pinned = false;
  let stopAnchor: (() => void) | null = null;
  let nodeListeners = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function panelClass() {
    return ["status-tip", still && "status-tip-still", wide && "status-tip-wide"]
      .filter(Boolean)
      .join(" ");
  }

  // Create the *visual* popover lazily (only when first shown) so hidden tooltip
  // text never pollutes the DOM / text queries; AT reads `aria-description` instead.
  function ensurePopover() {
    if (pop) {
      pop.textContent = text;
      pop.className = panelClass();
      return;
    }
    pop = document.createElement("div");
    pop.id = `status-tip-${++uid}`;
    pop.className = panelClass();
    pop.setAttribute("role", "tooltip");
    pop.setAttribute("popover", "manual");
    pop.textContent = text;
    // The panel is a body-appended sibling floating 6px off its trigger, so pointing at
    // it means leaving the trigger. Treat trigger + panel as one hover region: entering
    // the panel cancels the pending close, leaving it schedules one. Without this a
    // height-bounded (scrollable) panel could never be reached, which would put the
    // overflow of an uncapped description permanently out of reach.
    pop.addEventListener("pointerenter", (e) => {
      if ((e as PointerEvent).pointerType === "touch") return;
      cancelClose();
    });
    pop.addEventListener("pointerleave", (e) => {
      if ((e as PointerEvent).pointerType === "touch" || pinned) return;
      scheduleClose();
    });
    document.body.appendChild(pop);
  }

  function cancelClose() {
    if (closeTimer === null) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  // Grace period for the pointer to cross the gap between trigger and panel. Short
  // enough that an ordinary "move away" still reads as an immediate dismissal.
  function scheduleClose() {
    cancelClose();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      hide();
    }, 140);
  }

  function onDocPointerDown(e: PointerEvent) {
    const t = e.target as Node;
    if (node.contains(t) || pop?.contains(t)) return;
    hide();
  }
  function onScrollOrResize(e: Event) {
    // A scroll *inside* the panel is the reader using its own overflow (the `wide`
    // variant is height-bounded and scrolls), not the page moving out from under the
    // anchor — closing on it would make an overlong tooltip impossible to finish
    // reading. The listener is on window in capture phase, so it sees these too.
    if (e.type === "scroll" && pop && pop.contains(e.target as Node)) return;
    hide();
  }

  function show() {
    cancelClose();
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
    cancelClose();
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
    // Deferred, not immediate: the pointer may be on its way *into* the panel.
    scheduleClose();
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
    wide = next.wide ?? false;
    if (pop) {
      pop.textContent = text;
      pop.className = panelClass();
    }
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
