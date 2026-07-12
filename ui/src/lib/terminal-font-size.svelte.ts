const KEY = "shepherd:terminal-font-size";

/** Bounds for the experimental terminal-output font-size control (wrench menu).
 *  Reset (size === null) falls back to the per-device default in Viewport
 *  (12.5 desktop / 11 mobile). */
export const FONT_MIN = 8;
export const FONT_MAX = 24;

/** Pure: clamp a candidate px size into [FONT_MIN, FONT_MAX]. No rounding — the
 *  fractional 12.5 desktop default must survive a stored round-trip; the stepper
 *  itself only ever emits integers (see Viewport.stepTerminalFont). */
export function clampTerminalFontSize(px: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, px));
}

function read(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? clampTerminalFontSize(n) : null;
  } catch {
    return null;
  }
}

/** Persisted, global terminal-output font size. `size === null` means "use the
 *  per-device default"; a number is a pinned, clamped absolute px size applied to
 *  every terminal on this device. Mirrors the localStorage pattern of
 *  `herd-width.svelte.ts`, but a stepper tap is a discrete commit — so `set()`
 *  persists immediately (no drag → no live/commit split). */
class TerminalFontSize {
  size = $state<number | null>(read());

  /** Clamp, assign and persist a new size. */
  set(px: number) {
    this.size = clampTerminalFontSize(px);
    try {
      localStorage.setItem(KEY, String(this.size));
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }

  /** Reset to the per-device default (clears the pin + the stored value). */
  reset() {
    this.size = null;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* private mode / SSR — nothing to clear */
    }
  }
}

export const terminalFontSize = new TerminalFontSize();
