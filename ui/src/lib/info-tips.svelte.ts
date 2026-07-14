// Per-device opt-out for the app's opt-in help chrome: the circular (i) InfoTips,
// AutomationSettings' ⓘ row-explainers, and the dashed-underline glossary terms.
// Persisted in localStorage; mirrors tab-ticker.svelte.ts.
//
// Scope: only affordances that exist *purely to explain* adjacent content. Tooltips that
// attach to content itself — the statusTip action (StatusPip, the badges), the Stepper /
// HeartbeatStrip legends, native title= — are deliberately untouched: there the tooltip is
// the only decoding of an opaque glyph, so hiding it would make the UI unreadable rather
// than decluttered.
//
// No pre-paint bootstrap is needed (unlike theme/contrast in app.html): the app is
// ssr:false, so first paint is an empty shell with no icons in it, and this module's
// synchronous read() runs before the first component render. A plain {#if} guard on
// `hidden` therefore cannot flash.
const KEY = "shepherd:hide-info-tips";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

class InfoTips {
  hidden = $state(read());
  toggle() {
    this.set(!this.hidden);
  }
  set(v: boolean) {
    this.hidden = v;
    try {
      if (v) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const infoTips = new InfoTips();
export { read as readInfoTips };

// Context key that forces the help affordances to render regardless of the preference.
// Set once by the /design-system route: it is the canonical component catalogue, so a
// specimen that vanished based on the viewer's personal pref would make it lie.
export const INFO_TIPS_FORCE = Symbol("info-tips-force");
