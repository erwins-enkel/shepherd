// Shared accessible-dialog behavior for modal cards and drawers.
//
// Apply `use:dialog={{ onclose }}` to the modal's card/panel element to get:
//   • focus-trap   — Tab / Shift+Tab cycle within the dialog's focusable controls
//   • Escape       — calls onclose (skipped when defaultPrevented, so an inner
//                    handler — e.g. a slash menu closing on Escape — wins first)
//   • focus restore — returns focus to the element that was focused before the
//                     dialog opened, once the action's node unmounts
//
// On mount the action moves focus into the dialog UNLESS the component already
// focused a control of its own (NewTask → prompt, EmojiPicker → search). This
// is what makes aria-modal honest: the Tab-trap and Escape listener live on the
// node, so they only fire while focus sits inside it. Dialogs that autofocus a
// field keep that field; dialogs that don't (BroadcastDialog, BacklogOverlay,
// LeftoverDialog, Update/HerdrUpdateModal, TriageDrawer) get focus on the first
// focusable control, or the node itself as a fallback.

interface DialogParams {
  /** Invoked on Escape (and available for the caller to wire to its ✕ button). */
  onclose?: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(node: HTMLElement): HTMLElement[] {
  // getClientRects().length (not offsetParent) for the visible check: offsetParent
  // is null under any position:fixed ancestor, which would silently empty the trap
  // if a future dialog card is made fixed. getClientRects is 0 only for genuinely
  // unrendered (display:none) elements, so it stays correct for fixed cards too.
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 || el === document.activeElement,
  );
}

export function dialog(node: HTMLElement, params: DialogParams = {}) {
  let current = params;
  const previouslyFocused = document.activeElement as HTMLElement | null;

  // Give the node a programmatic focus target (out of tab order) so the trap has
  // a fallback when the dialog has no focusable child.
  if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");

  // Pull focus in once mounted. Deferred a microtask so a component's own
  // on-open focus (sync onMount) wins; guarded so a dialog closed before the
  // microtask runs doesn't steal focus. Without this, focus stays on the trigger
  // outside the node and neither the Tab-trap nor Escape would ever fire.
  queueMicrotask(() => {
    if (!document.contains(node) || node.contains(document.activeElement)) return;
    const items = focusable(node);
    (items[0] ?? node).focus({ preventScroll: true });
  });

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      // Let an inner handler that already consumed Escape (e.g. a popup menu)
      // take precedence — only close the dialog if nothing else did.
      if (e.defaultPrevented) return;
      e.preventDefault();
      current.onclose?.();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusable(node);
    if (items.length === 0) {
      e.preventDefault();
      node.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !node.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !node.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  node.addEventListener("keydown", onKeydown);

  return {
    update(next: DialogParams) {
      current = next ?? {};
    },
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      // Restore focus to where it was before the dialog opened, if that element
      // is still in the document and focusable.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    },
  };
}
