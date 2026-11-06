const SHARE_KEY = "shepherd:assistant-share";
const FOLDED_KEY = "shepherd:assistant-folded";

/** The docked panel's floor, px. */
export const ASSISTANT_MIN = 360;
/** The terminal's floor while unfolded, px: the panel's edge stops here. */
export const SESSION_MIN = 320;
/** Drag the edge until the terminal would be narrower than this and it folds into a strip. Half the
 *  floor, so aiming for the maximum doesn't fold by accident and unfolding needs less travel. */
export const FOLD_AT = SESSION_MIN / 2;

/** Pure: where a drag of the panel's left edge lands. `panelPx` is the width the pointer asks for,
 *  `sharedPx` the width the session column and the panel share. Unfolded, the panel keeps
 *  ASSISTANT_MIN and leaves the terminal SESSION_MIN; its width is returned as its share of
 *  `sharedPx`, so the split scales with the window. */
export function resolveAssistantDrag(
  panelPx: number,
  sharedPx: number,
): { folded: true } | { folded: false; share: number } {
  if (sharedPx - panelPx < FOLD_AT) return { folded: true };
  const max = Math.max(ASSISTANT_MIN, sharedPx - SESSION_MIN);
  const px = Math.min(max, Math.max(ASSISTANT_MIN, panelPx));
  return { folded: false, share: px / sharedPx };
}

/** Pure: the .grid's custom properties for a dragged share — the two tracks as per-mille fr, so they
 *  always add up to the whole shared width. Read by the `.grid.assistant` rules in +page.svelte. */
export function assistantShareStyle(share: number): string {
  const k = Math.round(share * 1000);
  return `--session-w:minmax(0,${1000 - k}fr);--assistant-w:minmax(${ASSISTANT_MIN}px,${k}fr)`;
}

/** Pure: a stored share, or null (the default width) for anything outside (0, 1). */
export function parseAssistantShare(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

function readShare(): number | null {
  try {
    return parseAssistantShare(localStorage.getItem(SHARE_KEY));
  } catch {
    return null;
  }
}

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** How the desktop grid splits its width while the Operator Assistant is docked, dragged at the
 *  panel's left edge (+page.svelte) and remembered per device. Mirrors `herd-width.svelte.ts`:
 *  live updates while dragging, persisted on commit. */
class AssistantLayoutPref {
  /** The panel's share of the width it shares with the session column; null = the default width. */
  share = $state<number | null>(readShare());
  /** The session column folded into a strip; `share` is then the width it unfolds to. */
  folded = $state<boolean>(readFolded());

  /** Live update during a drag — NOT persisted. `startShare` is the share the drag began with:
   *  folding mid-drag returns to it, so unfolding restores the width from before the drag. */
  drag(panelPx: number, sharedPx: number, startShare: number | null) {
    const next = resolveAssistantDrag(panelPx, sharedPx);
    this.folded = next.folded;
    this.share = next.folded ? startShare : next.share;
  }

  /** Persist the current width and fold. */
  commit() {
    try {
      if (this.share === null) localStorage.removeItem(SHARE_KEY);
      else localStorage.setItem(SHARE_KEY, String(this.share));
      if (this.folded) localStorage.setItem(FOLDED_KEY, "1");
      else localStorage.removeItem(FOLDED_KEY);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }

  /** Unfold the session column to the width it had before folding. */
  unfold() {
    this.folded = false;
    this.commit();
  }

  /** Back to the default width, unfolded (clears both stored values). */
  reset() {
    this.share = null;
    this.folded = false;
    this.commit();
  }
}

export const assistantLayout = new AssistantLayoutPref();
