// Shared accessible-dialog behavior for modal cards and drawers.
//
// Apply `use:dialog={{ onclose }}` to the modal's card/panel element to get:
//   • focus-trap   — Tab / Shift+Tab cycle within the dialog's focusable controls
//   • Escape       — calls onclose (skipped when defaultPrevented, so an inner
//                    handler — e.g. a slash menu closing on Escape — wins first)
//   • focus restore — returns focus to the element that was focused before the
//                     dialog opened, once the action's node unmounts
//
// The action does NOT move focus into the dialog on mount: components that
// already focus a specific field (NewTask → prompt, Settings, EmojiPicker)
// keep that behavior. When nothing inside is focused and the dialog gains no
// initial focus, the node itself should carry tabindex="-1" so the trap has a
// fallback — but most dialogs here focus a control on open.

interface DialogParams {
  /** Invoked on Escape (and available for the caller to wire to its ✕ button). */
  onclose?: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function dialog(node: HTMLElement, params: DialogParams = {}) {
  let current = params;
  const previouslyFocused = document.activeElement as HTMLElement | null;

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
