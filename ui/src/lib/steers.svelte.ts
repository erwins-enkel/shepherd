import type { Steer } from "./types";
import { getSteers, putSteers } from "./api";

// Client cache of the saved canned steers. Loaded once on app start; every
// mutation persists to the server and adopts the normalized result.
class SteersStore {
  list = $state<Steer[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);

  async load() {
    try {
      this.list = await getSteers();
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to load steers";
    } finally {
      this.loaded = true;
    }
  }

  /** Replace the whole list (Settings editor). Persists + adopts the normalized list. */
  async save(next: Steer[]) {
    this.error = null;
    try {
      this.list = await putSteers(next);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to save steers";
      throw e;
    }
  }
}

export const steers = new SteersStore();
