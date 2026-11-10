/**
 * Copy-on-select: when a mouse drag that began inside `el` is released, write `read()` to the
 * clipboard (nothing when it is empty). Shared by the agent terminals — where Ctrl+C sends SIGINT
 * to the agent rather than copying — and the Chat, so a finished selection lands on the clipboard
 * the same way everywhere. Returns a disposer.
 *
 * A drag can end outside `el` (xterm tracks it with document-level listeners), so the release is
 * heard on the document, gated to presses that began in `el`. The press gate is capture-phase:
 * xterm stops the mousedown from bubbling to `el`, so a bubble-phase listener never sees it —
 * capture fires top-down before xterm can swallow it. A plain click clears the selection first,
 * so `read()` is empty → no spurious copy.
 */
export function copyOnSelect(el: HTMLElement, read: () => string): () => void {
  let armed = false;
  const onDown = () => {
    armed = true;
  };
  const onUp = () => {
    if (!armed) return;
    armed = false;
    const text = read();
    if (text) {
      navigator.clipboard?.writeText(text)?.catch((err) => {
        console.warn("copy-on-select: clipboard write failed", err);
      });
    }
  };
  el.addEventListener("mousedown", onDown, true);
  document.addEventListener("mouseup", onUp);
  return () => {
    el.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("mouseup", onUp);
  };
}
