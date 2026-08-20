/** Bringing a jumped-to rail row into view. Sibling of herd-jump.ts: that module decides
 *  WHICH session a global jump lands on and reveals it out of a collapsed group, this one
 *  decides whether the rail still has to scroll to it — and finds the box that would do
 *  the scrolling. Split out of +page.svelte so the geometry is testable with plain
 *  numbers, without a live scroll container. */

/** A vertical extent in viewport coordinates — the `top`/`bottom` pair of a DOMRect. */
export type Span = { top: number; bottom: number };

/** Whether a jump has to scroll `row` to the middle of `view`.
 *
 *  A row already fully inside the viewport keeps its position: the operator jumped to
 *  something they can already see, and yanking the list under them would be pure jitter.
 *  Anything clipped at either edge — or off-screen entirely — is centred, so the row
 *  lands with context above and below it instead of glued to a rail edge.
 *
 *  A row TALLER than the viewport can never be "fully inside", so it centres too, which
 *  is the best available framing for it. */
export function needsCentering(row: Span, view: Span): boolean {
  return row.top < view.top || row.bottom > view.bottom;
}

/** The element that actually scrolls `el`: the nearest ancestor that both scrolls on the
 *  block axis and has overflow to scroll. Null means the page itself scrolls — the rail's
 *  mobile flow mode drops `.units` to `overflow: visible` and lets the document scroll,
 *  and callers pair that with the window's own viewport extent. */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}
