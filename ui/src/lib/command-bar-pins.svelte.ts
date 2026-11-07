// Command-bar pins (#3052): the operator's pinned rows, keyed by CommandBar's `stableKey()`
// (`c:new-task`, `s:<id>`, `r:<path>`, `l:<lens>`, `d:<url>`) and kept in pin order. Per device —
// localStorage only, the same pattern as build-queue-collapse.svelte.ts.

const KEY = "shepherd:commandbar-pins";
export const MAX_PINS = 9;

type PinToggle = "pinned" | "unpinned" | "full";

/** Tolerant parse: anything but an array of strings degrades to no pins; dupes drop, cap holds. */
function read(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const keys = raw.filter((k): k is string => typeof k === "string" && k !== "");
    return [...new Set(keys)].slice(0, MAX_PINS);
  } catch {
    return [];
  }
}

class CommandBarPins {
  keys = $state<string[]>(read());

  has(key: string): boolean {
    return this.keys.includes(key);
  }

  /** Pin or unpin `key`. A pin past MAX_PINS is refused ("full") and changes nothing. */
  toggle(key: string): PinToggle {
    if (this.has(key)) {
      this.#write(this.keys.filter((k) => k !== key));
      return "unpinned";
    }
    if (this.keys.length >= MAX_PINS) return "full";
    this.#write([...this.keys, key]);
    return "pinned";
  }

  /** Drop every pin `keep` rejects. Writes only when something was dropped. */
  prune(keep: (key: string) => boolean) {
    const next = this.keys.filter(keep);
    if (next.length !== this.keys.length) this.#write(next);
  }

  /** Re-read storage (another tab's change, or a test seeding it). */
  load() {
    this.keys = read();
  }

  #write(next: string[]) {
    this.keys = next;
    try {
      if (next.length > 0) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode / quota — pins just won't survive a reload */
    }
  }
}

export const commandBarPins = new CommandBarPins();
