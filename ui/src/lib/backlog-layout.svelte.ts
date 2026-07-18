// Persisted desktop layout for the Repos modal (BacklogOverlay) + its internal
// repository sidebar (BacklogView). Mirrors herd-width.svelte.ts: a singleton of
// $state prefs (null = "use the CSS default"), a live set() during a drag, a
// commit() on pointerup, and a reset() that clears both the state + stored value.
// All localStorage access is try/caught (SSR / private mode). Issue #1787.

const KEY_W = "shepherd:repos-modal-w";
const KEY_H = "shepherd:repos-modal-h";
const KEY_SB = "shepherd:repos-sidebar-w";

// Modal floors — keep the header, tabs, repo controls + detail content usable.
export const MODAL_MIN_W = 640;
export const MODAL_MIN_H = 460;
// The .overlay padding (24px each side) the live viewport ceiling must leave free
// so the card edge / close button can't be clipped. Mirrored in the render CSS as
// min(stored, calc(100vw - 48px)).
export const OVERLAY_PAD = 48;

// Sidebar bounds. MIN aligns to the existing design min track (minmax(220px,300px));
// DETAIL_MIN keeps the detail column usable, so the sidebar's live max always
// leaves it room. The 300px default lives in CSS (var(--repos-sidebar, 300px)).
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 560;
export const DETAIL_MIN = 380;

// Generous absolute ceiling for a stored dimension — rejects garbage at parse time
// while the live viewport ceiling is enforced in CSS.
const ABS_MAX = 10000;

/** Parse a raw localStorage string into a sane positive px number, else null.
 *  Rejects non-numeric / non-finite / non-positive / out-of-sanity-range values
 *  (corrupt-storage fallback). Kept pure + exported for unit testing. */
export function parseStored(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= ABS_MAX ? n : null;
}

/** Round + clamp a modal width into [MODAL_MIN_W, min(vw - OVERLAY_PAD, ABS_MAX)].
 *  `vw` = viewport width (pass window.innerWidth live during a drag, or a fixed
 *  value in tests). Used by the corner-drag handler; render CSS mirrors the ceiling. */
export function clampModalWidth(px: number, vw: number): number {
  const max = Math.min(ABS_MAX, Math.max(MODAL_MIN_W, vw - OVERLAY_PAD));
  return Math.round(Math.min(max, Math.max(MODAL_MIN_W, px)));
}

/** Round + clamp a modal height into [MODAL_MIN_H, min(vh - OVERLAY_PAD, ABS_MAX)]. */
export function clampModalHeight(px: number, vh: number): number {
  const max = Math.min(ABS_MAX, Math.max(MODAL_MIN_H, vh - OVERLAY_PAD));
  return Math.round(Math.min(max, Math.max(MODAL_MIN_H, px)));
}

/** Round + clamp a sidebar width into
 *  [SIDEBAR_MIN, min(SIDEBAR_MAX, modalInnerW - DETAIL_MIN)].
 *  `modalInnerW` = the .desktop-split width; keeps the detail pane >= DETAIL_MIN. */
export function clampSidebarWidth(px: number, modalInnerW: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, modalInnerW - DETAIL_MIN));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, px)));
}

function readNum(key: string): number | null {
  try {
    return parseStored(localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Sidebar read applies the viewport-independent [SIDEBAR_MIN, SIDEBAR_MAX] clamp
 *  at init; the component re-clamps against the live split width (DETAIL_MIN) on
 *  the next render/drag. */
function readSidebar(): number | null {
  const n = readNum(KEY_SB);
  if (n === null) return null;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)));
}

/** Persisted, drag-driven desktop layout for the Repos modal. Each field null =
 *  "use the responsive default"; a number is a pinned px value. */
class BacklogLayout {
  width = $state<number | null>(readNum(KEY_W));
  height = $state<number | null>(readNum(KEY_H));
  sidebar = $state<number | null>(readSidebar());

  /** Live modal-drag update — caller pre-clamps with clampModal{Width,Height};
   *  NOT persisted (avoids localStorage thrash on every pointermove). */
  setModal(w: number, h: number) {
    this.width = w;
    this.height = h;
  }

  /** Persist the modal size. No-ops when unset so a never-moved drag can't pin
   *  the default. */
  commitModal() {
    if (this.width === null || this.height === null) return;
    try {
      localStorage.setItem(KEY_W, String(this.width));
      localStorage.setItem(KEY_H, String(this.height));
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }

  /** Reset the modal to its CSS default (clears the pin + stored values). */
  resetModal() {
    this.width = null;
    this.height = null;
    try {
      localStorage.removeItem(KEY_W);
      localStorage.removeItem(KEY_H);
    } catch {
      /* private mode / SSR — nothing to clear */
    }
  }

  /** Live sidebar-drag update — caller pre-clamps with clampSidebarWidth. */
  setSidebar(w: number) {
    this.sidebar = w;
  }

  commitSidebar() {
    if (this.sidebar === null) return;
    try {
      localStorage.setItem(KEY_SB, String(this.sidebar));
    } catch {
      /* private mode / SSR */
    }
  }

  resetSidebar() {
    this.sidebar = null;
    try {
      localStorage.removeItem(KEY_SB);
    } catch {
      /* private mode / SSR */
    }
  }
}

export const backlogLayout = new BacklogLayout();
