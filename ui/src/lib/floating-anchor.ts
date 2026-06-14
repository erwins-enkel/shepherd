import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";

// Anchor a native `popover` floating element under a reference element, keeping it
// positioned on scroll / resize / movement via Floating UI autoUpdate. Returns a
// cleanup that stops autoUpdate and hides the popover — call it from an $effect
// teardown. Shared by Coachmark and GlossaryTerm so the position loop + teardown
// live in one place rather than being duplicated per popover component.
export function anchorPopover(reference: HTMLElement, floating: HTMLElement, gap = 8): () => void {
  const stop = autoUpdate(reference, floating, () => {
    computePosition(reference, floating, {
      placement: "bottom",
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
