import type { SessionStore } from "./store";

const SETTING_KEY = "projectIcons";
const MAX_ENTRIES = 500; // safety bound; far above any realistic repo count

type IconStore = Pick<SessionStore, "getSetting" | "setSetting">;

/** Read the saved repoPath→emoji map. Empty default; tolerant of corrupt JSON. */
export function loadIcons(store: IconStore): Record<string, string> {
  const raw = store.getSetting(SETTING_KEY);
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Patch a single project's emoji ("" clears it), persist, and return the full map.
 * New paths beyond MAX_ENTRIES (500) are silently ignored; existing paths always update.
 */
export function setIcon(store: IconStore, path: string, emoji: string): Record<string, string> {
  const map = loadIcons(store);
  if (emoji === "") {
    delete map[path];
  } else if (path in map || Object.keys(map).length < MAX_ENTRIES) {
    map[path] = emoji;
  }
  store.setSetting(SETTING_KEY, JSON.stringify(map));
  return map;
}
