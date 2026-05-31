// App theme controller. The user's preference is dark / light / system; the
// *resolved* value (dark | light) is what the CSS keys on via the
// `data-theme` attribute on <html>. An inline script in app.html sets that
// attribute before first paint (no flash of wrong theme); this module owns it
// at runtime so the switcher and OS-theme changes stay in sync.

export type ThemePref = "dark" | "light" | "system";
export type Resolved = "dark" | "light";

const STORAGE_KEY = "shepherd:theme";
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

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" ? matchMedia(DARK_QUERY).matches : true;
}

class ThemeController {
  pref = $state<ThemePref>(readPref());
  systemDark = $state<boolean>(systemPrefersDark());

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

  #apply() {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = this.resolved;
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
