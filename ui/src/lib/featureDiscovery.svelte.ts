// Seen-state store for feature discovery (What's-New + coachmarks).
// SSR-safe: localStorage is NEVER touched at module init.
// Callers invoke hydrate() inside onMount / $effect after the DOM is ready.

const KEY_VERSION = "shepherd:whats-new:lastSeenVersion";
const KEY_SEEN = "shepherd:features-seen";

class FeatureDiscoveryStore {
  #lastSeenVersion = $state<string | null>(null);
  #seen = $state<Record<string, true>>({});

  /** Populate both state fields from localStorage.
   *  Each key is read in its own try/catch so a corrupt `seen` blob
   *  cannot discard a valid `lastSeenVersion`. */
  hydrate() {
    try {
      const v = localStorage.getItem(KEY_VERSION);
      this.#lastSeenVersion = v ?? null;
    } catch {
      /* private mode / SSR — leave null */
    }
    try {
      const raw = localStorage.getItem(KEY_SEEN);
      if (raw) {
        this.#seen = JSON.parse(raw) as Record<string, true>;
      } else {
        this.#seen = {};
      }
    } catch {
      /* corrupt blob — fall back to empty; lastSeenVersion already set above */
      this.#seen = {};
    }
  }

  get lastSeenVersion(): string | null {
    return this.#lastSeenVersion;
  }

  /** Persist the version to localStorage immediately. */
  set lastSeenVersion(v: string | null) {
    this.#lastSeenVersion = v;
    try {
      if (v === null) {
        localStorage.removeItem(KEY_VERSION);
      } else {
        localStorage.setItem(KEY_VERSION, v);
      }
    } catch {
      /* private mode — state updated in memory, won't survive reload */
    }
  }

  /** Read-only view of the seen set. Use markSeen() to mutate. */
  get seen(): Record<string, true> {
    return this.#seen;
  }

  /** Returns true when the feature id has been marked seen. */
  isSeen(id: string): boolean {
    return id in this.#seen;
  }

  /** Mark a feature as seen and persist the seen blob. */
  markSeen(id: string): void {
    this.#seen = { ...this.#seen, [id]: true };
    try {
      localStorage.setItem(KEY_SEEN, JSON.stringify(this.#seen));
    } catch {
      /* private mode — state updated in memory */
    }
  }
}

export const featureDiscovery = new FeatureDiscoveryStore();
