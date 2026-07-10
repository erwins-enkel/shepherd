const KEY = "shepherd:herd-width";

/** Drag clamp for the desktop Herd sidebar (issue #1588). Reset (width === null)
 *  falls back to the responsive `minmax(300px, 360px)` default in +page.svelte. */
export const HERD_MIN = 260;
export const HERD_MAX = 560;

/** Pure: round + clamp a candidate px width into [HERD_MIN, HERD_MAX]. Unit-testable. */
export function clampHerdWidth(px: number): number {
  return Math.round(Math.min(HERD_MAX, Math.max(HERD_MIN, px)));
}

function read(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? clampHerdWidth(n) : null;
  } catch {
    return null;
  }
}

/** Persisted, drag-driven width for the desktop Herd sidebar. `width === null`
 *  means "use the responsive default"; a number is a pinned, clamped px width.
 *  Mirrors the localStorage pattern of `sidebar-collapse.svelte.ts`. */
class HerdWidth {
  width = $state<number | null>(read());

  /** Live update during a drag — clamped, NOT persisted (avoids localStorage
   *  thrash on every pointermove). Call commit() on pointerup to persist. */
  set(px: number) {
    this.width = clampHerdWidth(px);
  }

  /** Persist the current width. No-ops when null so a pure click / never-moved
   *  drag can't convert the responsive default into a fixed pinned width. */
  commit() {
    if (this.width === null) return;
    try {
      localStorage.setItem(KEY, String(this.width));
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }

  /** Reset to the responsive default (clears the pin + the stored value). */
  reset() {
    this.width = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* private mode / SSR — nothing to clear */
    }
  }
}

export const herdWidth = new HerdWidth();
