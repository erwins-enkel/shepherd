// App theme controller. The user's preference is dark / light / system; the
// *resolved* value (dark | light) is what the CSS keys on via the
// `data-theme` attribute on <html>. An inline script in app.html sets that
// attribute before first paint (no flash of wrong theme); this module owns it
// at runtime so the switcher and OS-theme changes stay in sync.

export type ThemePref = "dark" | "light" | "system";
export type Resolved = "dark" | "light";

const STORAGE_KEY = "shepherd:theme";
const CONTRAST_KEY = "shepherd:contrast";
const COLORBLIND_KEY = "shepherd:colorblind";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
  }
  return "system";
}

function readContrast(): boolean {
  try {
    return localStorage.getItem(CONTRAST_KEY) === "high";
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
    return false;
  }
}

function readColorblind(): boolean {
  try {
    return localStorage.getItem(COLORBLIND_KEY) === "on";
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
    return false;
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" ? matchMedia(DARK_QUERY).matches : true;
}

class ThemeController {
  pref = $state<ThemePref>(readPref());
  systemDark = $state<boolean>(systemPrefersDark());

  // High-contrast (WCAG / "Brillenträger") is a separate accessibility *layer*,
  // not a theme: it composes on top of whichever dark/light theme is resolved,
  // strengthening the low-contrast greys/hairlines via [data-contrast="high"].
  contrast = $state<boolean>(readContrast());

  // Colourblind status markers: opt-in shape glyph (✓ done / ! blocked) that
  // partners the saturated header tint on phone so the two states don't rest on
  // hue alone (WCAG 1.4.1). Off by default — the redundant glyph is noise for
  // normal-sighted users, but a rotgrün-confused operator can switch it on.
  colorblind = $state<boolean>(readColorblind());

  resolved = $derived<Resolved>(
    this.pref === "system" ? (this.systemDark ? "dark" : "light") : this.pref,
  );

  /** Persist + apply a new preference. */
  setPref(p: ThemePref) {
    this.pref = p;
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* ignore — preference just won't survive reload */
    }
    this.#apply();
  }

  /** Cycle dark → light → system → dark (compact mobile control). */
  cycle() {
    this.setPref(this.pref === "dark" ? "light" : this.pref === "light" ? "system" : "dark");
  }

  /** Persist + apply the high-contrast layer (independent of dark/light). */
  setContrast(on: boolean) {
    this.contrast = on;
    try {
      localStorage.setItem(CONTRAST_KEY, on ? "high" : "off");
    } catch {
      /* ignore — preference just won't survive reload */
    }
    this.#apply();
  }

  toggleContrast() {
    this.setContrast(!this.contrast);
  }

  /** Persist the colourblind status-marker preference (consumed in-component). */
  setColorblind(on: boolean) {
    this.colorblind = on;
    try {
      localStorage.setItem(COLORBLIND_KEY, on ? "on" : "off");
    } catch {
      /* ignore — preference just won't survive reload */
    }
  }

  toggleColorblind() {
    this.setColorblind(!this.colorblind);
  }

  #apply() {
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.dataset.theme = this.resolved;
      // Keep browser chrome (PWA title bar, mobile status bar) in sync.
      // Hexes mirror app.css --color-bg per theme (same values as the
      // pre-paint script in app.html).
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", this.resolved === "dark" ? "#0a0d0c" : "#e7ebe9");
      if (this.contrast) root.dataset.contrast = "high";
      else delete root.dataset.contrast;
    }
  }

  /** Wire OS-theme changes. Call once on mount; returns a disposer. */
  init(): () => void {
    this.#apply();
    if (typeof matchMedia === "undefined") return () => {};
    const mq = matchMedia(DARK_QUERY);
    const onChange = () => {
      this.systemDark = mq.matches;
      this.#apply();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }
}

export const theme = new ThemeController();

/**
 * xterm theme object for the active app theme. Reads the live computed token
 * values so it tracks whatever `[data-theme]` is currently applied; the
 * `resolved` argument only supplies a fallback if a custom property is missing.
 */
export function xtermTheme(resolved: Resolved): { background: string; foreground: string } {
  const fallback =
    resolved === "light"
      ? { background: "#f3f6f4", foreground: "#2b3633" }
      : { background: "#070a09", foreground: "#c4d0cb" };
  if (typeof document === "undefined") return fallback;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, f: string) => cs.getPropertyValue(name).trim() || f;
  return {
    background: read("--color-inset", fallback.background),
    foreground: read("--color-term-fg", fallback.foreground),
  };
}

/**
 * Contrast floor xterm enforces between each glyph and its cell background.
 * Claude's TUI is tuned for a dark terminal: on the near-white light surface its
 * bright/white and washed-out secondary greys drop near-invisible. xterm's
 * `minimumContrastRatio` darkens only the under-contrast pairs (hue preserved)
 * back to legible; body text already above the floor is left alone.
 *
 * The floor is `7`, not the WCAG-AA `4.5`, because Claude renders its secondary
 * lines (search results, tool output, "(ctrl+o to expand)") with the ANSI *dim*
 * attribute, and xterm only holds dim cells to *half* the configured ratio
 * (`minimumContrastRatio / 2`). `7` lands dim text at ~3.5:1 — clearly readable
 * yet still visibly secondary — while non-dim glyphs get the full 7:1.
 *
 * Dark mode is already legible — `1` disables enforcement (xterm's no-op fast
 * path), so this never touches the dark palette.
 *
 * When the high-contrast layer is on, the floor jumps to `7` in *both* themes so
 * the terminal's dim secondary lines are lifted to ~3.5:1 even on the dark
 * palette — matching the WCAG boost the app chrome gets via [data-contrast].
 */
export function xtermMinContrast(resolved: Resolved, highContrast = theme.contrast): number {
  if (highContrast) return 7;
  return resolved === "light" ? 7 : 1;
}
