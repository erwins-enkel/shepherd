// Per-device opt-in for the compact glyph tab title (⚠ ✋ ✓ ▶ counts) instead of
// the plain (N). Persisted in localStorage; mirrors build-queue-collapse.svelte.ts.
const KEY = "shepherd:tab-glyph-ticker";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

class TabTicker {
  enabled = $state(read());
  toggle() {
    this.set(!this.enabled);
  }
  set(v: boolean) {
    this.enabled = v;
    try {
      if (v) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const tabTicker = new TabTicker();
export { read as readTabTicker };
