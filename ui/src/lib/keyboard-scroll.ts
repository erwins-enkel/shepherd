// Soft-keyboard detection + the global "scroll back after the keyboard closes" fix (#3795).
//
// iOS scrolls the document to keep a focused field visible; in a home-screen (standalone) PWA
// the document often stays scrolled after the keyboard closes, leaving the pinned chrome under
// the status bar and a grey gap at the bottom. One listener for the whole app restores the
// scroll position from before the keyboard opened.

/** Soft-keyboard occlusion threshold in CSS px. `innerHeight − vv.height×scale` is ≈ 0 under
 *  pure pinch zoom (vv.height shrinks by exactly 1/scale) and ≈ keyboard height when the
 *  keyboard is up, zoomed or not. The threshold sits between transient browser-chrome/vv
 *  jitter (≤ ~100 px, and innerHeight moves with it) and the smallest real keyboards (iPhone
 *  landscape ≥ ~160 px). */
const KEYBOARD_MIN_OCCLUSION = 100;

export function keyboardOccluded(
  innerHeight: number,
  vv: { height: number; scale: number },
): boolean {
  return Math.round(innerHeight - vv.height * vv.scale) > KEYBOARD_MIN_OCCLUSION;
}

/** The slice of `window` the restore needs — injectable so the logic is node-testable. */
export interface KeyboardScrollWindow {
  readonly scrollY: number;
  readonly innerHeight: number;
  scrollTo(x: number, y: number): void;
  readonly visualViewport: (EventTarget & { height: number; scale: number }) | null;
  matchMedia(query: string): { matches: boolean };
  readonly document: EventTarget & { scrollingElement: { scrollHeight: number } | null };
}

/** Restore the document scroll to its pre-keyboard position when the soft keyboard closes.
 *  Fixed-height screens were at 0, so they snap back to the top; the document-scrolled phone
 *  list returns to where it was (clamped to the current scroll range). Touch-only; returns the
 *  disposer. */
export function installKeyboardScrollRestore(
  win: KeyboardScrollWindow = window as unknown as KeyboardScrollWindow,
): () => void {
  const vv = win.visualViewport;
  if (!vv || !win.matchMedia("(pointer: coarse)").matches) return () => {};

  const doc = win.document;
  let open = keyboardOccluded(win.innerHeight, vv);
  let savedY: number | null = null;

  // Sample before the keyboard opens. pointerdown precedes iOS's focus scroll and also covers
  // tapping an already-focused field (a programmatic focus() raises no keyboard on iOS).
  const sample = () => {
    if (!open) savedY = win.scrollY;
  };
  const onResize = () => {
    const wasOpen = open;
    open = keyboardOccluded(win.innerHeight, vv);
    // Pinch zoom also resizes the visual viewport; never fight the user's zoom.
    if (!wasOpen || open || Math.abs(vv.scale - 1) >= 0.01) return;
    const maxY = Math.max(0, (doc.scrollingElement?.scrollHeight ?? 0) - win.innerHeight);
    const target = Math.min(savedY ?? 0, maxY);
    savedY = null;
    if (win.scrollY !== target) win.scrollTo(0, target);
  };

  doc.addEventListener("pointerdown", sample, true);
  doc.addEventListener("focusin", sample, true);
  vv.addEventListener("resize", onResize);
  return () => {
    doc.removeEventListener("pointerdown", sample, true);
    doc.removeEventListener("focusin", sample, true);
    vv.removeEventListener("resize", onResize);
  };
}
