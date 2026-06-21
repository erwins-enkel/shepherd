import { autoUpdate, computePosition, flip, offset, type Placement, shift } from "@floating-ui/dom";

// Anchor a native `popover` floating element relative to a reference element, keeping
// it positioned on scroll / resize / movement via Floating UI autoUpdate. Returns a
// cleanup that stops autoUpdate and hides the popover — call it from an $effect
// teardown. Shared by Coachmark, GlossaryTerm, and InfoTip so the position loop +
// teardown live in one place rather than being duplicated per popover component.
// `placement` defaults to "bottom"; `flip()` still re-homes it to the opposite side
// when the preferred side lacks room.
//
// strategy:"fixed" matches the `position: fixed` these popovers carry in CSS (they
// live in the top layer, whose containing block is the viewport). Without it Floating
// UI computes document-relative coords while the browser interprets left/top as
// viewport-relative, so inside a scrolled container the popover drifts from its anchor
// by exactly the scroll offset.
export function anchorPopover(
  reference: HTMLElement,
  floating: HTMLElement,
  gap = 8,
  placement: Placement = "bottom",
): () => void {
  const stop = autoUpdate(reference, floating, () => {
    computePosition(reference, floating, {
      placement,
      strategy: "fixed",
      middleware: [offset(gap), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      floating.style.left = x + "px";
      floating.style.top = y + "px";
    });
  });

  return () => {
    stop();
    try {
      floating.hidePopover();
    } catch {
      // Already hidden or detached — ignore.
    }
  };
}
