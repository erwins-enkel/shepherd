// Per-device choice of the tab a session view opens on. "auto" keeps the device
// default (phone/touch → Chat, desktop → Terminal). Persisted in localStorage;
// mirrors tab-ticker.svelte.ts.
export type SessionStartTab = "auto" | "chat" | "term";

const KEY = "shepherd:session-start-tab";

function read(): SessionStartTab {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "chat" || v === "term") return v;
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
  }
  return "auto";
}

/** Pure: the tab a session opens on for this preference and device. */
export function resolveStartTab(
  pref: SessionStartTab,
  device: { mobile: boolean; touch: boolean },
): "chat" | "term" {
  if (pref !== "auto") return pref;
  return device.mobile || device.touch ? "chat" : "term";
}

class SessionStartTabStore {
  pref = $state<SessionStartTab>(read());
  set(v: SessionStartTab) {
    this.pref = v;
    try {
      if (v === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, v);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const sessionStartTab = new SessionStartTabStore();
export { read as readSessionStartTab };
