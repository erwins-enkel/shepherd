import type { Recap } from "./types";
import { getRecaps } from "./api";
import { setKey } from "./safe-keys";

/** Client cache of session recaps keyed by session id. Loaded once on app start;
 *  live updates arrive via the `session:recap` WS event (see store.svelte.ts). */
class RecapsStore {
  map = $state<Record<string, Recap>>({});

  async load() {
    try {
      this.map = await getRecaps();
    } catch {
      /* best-effort; live events still populate */
    }
  }

  apply(d: { id: string; recap: Recap | null }) {
    if (d.recap) this.map = setKey(this.map, d.id, d.recap);
    else {
      const copy = { ...this.map };
      delete copy[d.id];
      this.map = copy;
    }
  }

  drop(id: string) {
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const recaps = new RecapsStore();
