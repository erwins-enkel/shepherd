import { longPress } from "./longpress";

// Svelte action: open an issue-row context menu on desktop right-click OR touch
// long-press. Modelled on Viewport.svelte's longPress + lastPointerType recipe —
// NOT CardMenu, which leans on the native `contextmenu` that longpress.ts documents
// as unreliable on touch.
//
// Dedup: Android Chrome fires BOTH a native `contextmenu` and the 500ms longPress
// on a touch long-press. We let longPress own the open on touch and bail out of the
// `contextmenu` handler — still preventing its default so the native menu never
// shows and the touchcancel it would otherwise trigger can't kill the longPress
// timer. The touch-vs-mouse decision keys off the pointer type of the LAST
// pointerdown, never device capability, so a real mouse right-click on a touchscreen
// laptop still opens the menu.

// One window listener shared by every trigger instance; ref-counted so it installs
// on the first mount and tears down when the last row unmounts. Capture phase so it
// records the type before any target handler runs.
let lastPointerType = "";
let refCount = 0;
function onWinPointerDown(e: PointerEvent) {
  lastPointerType = e.pointerType;
}
function onWinKeyDown() {
  lastPointerType = ""; // keyboard Menu key must not be read as a pointer type
}
function acquire() {
  if (refCount++ === 0) {
    window.addEventListener("pointerdown", onWinPointerDown, { capture: true });
    window.addEventListener("keydown", onWinKeyDown, { capture: true });
  }
}
function release() {
  if (--refCount === 0) {
    window.removeEventListener("pointerdown", onWinPointerDown, { capture: true });
    window.removeEventListener("keydown", onWinKeyDown, { capture: true });
  }
}

export type IssueMenuTriggerOpts = {
  /** Open the menu at viewport coords, with `node` as the focus-return opener. */
  onopen: (x: number, y: number, node: HTMLElement) => void;
};

export function issueMenuTrigger(node: HTMLElement, opts: IssueMenuTriggerOpts) {
  let o = opts;
  acquire();

  function onContextMenu(e: MouseEvent) {
    // Never surface the browser's native menu over an issue row.
    e.preventDefault();
    // Touch long-press: longPress owns the open, so bail here — this keeps Android's
    // simultaneous native contextmenu from opening a second menu.
    if (lastPointerType === "touch") return;
    o.onopen(e.clientX, e.clientY, node);
  }
  node.addEventListener("contextmenu", onContextMenu);

  const trigger = (x: number, y: number) => {
    o.onopen(x, y, node);
    return true; // suppress the trailing synthetic click so the row's own click can't also fire
  };
  const lp = longPress(node, { onTrigger: trigger });

  return {
    update(next: IssueMenuTriggerOpts) {
      o = next;
      lp.update({ onTrigger: trigger });
    },
    destroy() {
      node.removeEventListener("contextmenu", onContextMenu);
      lp.destroy();
      release();
    },
  };
}
