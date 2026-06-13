// Teleport an element to a target (default <body>) for the lifetime of the action.
//
// A `position: fixed` overlay normally resolves against the viewport — UNLESS an
// ancestor establishes a containing block (a `transform`, `will-change`, or
// `filter`), in which case `fixed` is trapped to that ancestor's box instead.
// UnitRow's swipe slider (`.slider`, `will-change: transform` + inline
// `transform: translateX(0)`) does exactly this on coarse-pointer devices, so a
// modal rendered inside a row (PlanPanel via PlanGateBadge) was sized to the row
// rather than the screen — inline, undimmed, and un-closable.
//
// `use:portal` moves the node out to <body> on mount (no transformed ancestor
// there), restoring honest viewport-relative `fixed`, and removes it on destroy.
export function portal(node: HTMLElement, target: HTMLElement = document.body) {
  target.appendChild(node);
  return {
    destroy() {
      // Optional-chain the removal so a double-teardown (Svelte may already have
      // detached the node) is a harmless no-op rather than a throw.
      node.parentNode?.removeChild(node);
    },
  };
}
