// Persisted desktop layout for the Repos modal (BacklogOverlay). Mirrors
// herd-width.svelte.ts: a singleton of $state prefs (null = "use the CSS default"),
// a live set() during a drag, a commit() on pointerup, and a reset() that clears
// both the state + stored value. The repo list is a header popover now, so there is
// no sidebar width to persist.
// All localStorage access is try/caught (SSR / private mode). Issue #1787.

const KEY_W = "shepherd:repos-modal-w";
const KEY_H = "shepherd:repos-modal-h";

// Modal floors — keep the header, tabs, repo controls + detail content usable.
export const MODAL_MIN_W = 640;
export const MODAL_MIN_H = 460;
// The .overlay padding (24px each side) the live viewport ceiling must leave free
// so the card edge / close button can't be clipped. Mirrored in the render CSS as
// min(stored, calc(100vw - 48px)).
export const OVERLAY_PAD = 48;

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

function readNum(key: string): number | null {
  try {
    return parseStored(localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Persisted, drag-driven desktop layout for the Repos modal. Each field null =
 *  "use the responsive default"; a number is a pinned px value. */
class BacklogLayout {
  width = $state<number | null>(readNum(KEY_W));
  height = $state<number | null>(readNum(KEY_H));

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
}

export const backlogLayout = new BacklogLayout();
