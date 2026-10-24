import type { Recap } from "./types";
import { getRecaps, getSessionRecap } from "./api";
import { dropKey, setKey } from "./safe-keys";

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
      this.map = dropKey(this.map, d.id);
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

/** Owned by an open detail surface, separate from the summary cache. */
export class RecapDetailState {
  recap = $state<Recap>();
  loading = $state(false);
  error = $state(false);
  private key = $state("");
  private generation = 0;

  current(id: string, summary: Recap | undefined): Recap | undefined {
    return summary && this.key === `${id}:${summary.updatedAt}:${summary.state}`
      ? this.recap
      : undefined;
  }

  async load(id: string, summary: Recap | undefined) {
    this.clear();
    if (!summary || summary.state !== "ready") return;
    const mine = this.generation;
    this.key = `${id}:${summary.updatedAt}:${summary.state}`;
    this.loading = true;
    try {
      const recap = await getSessionRecap(id);
      if (mine !== this.generation) return;
      if (
        recap.sessionId === id &&
        recap.updatedAt >= summary.updatedAt &&
        recap.state === summary.state
      )
        this.recap = recap;
      else this.error = true;
    } catch {
      if (mine === this.generation) this.error = true;
    } finally {
      if (mine === this.generation) this.loading = false;
    }
  }

  clear() {
    this.generation++;
    this.key = "";
    this.recap = undefined;
    this.loading = false;
    this.error = false;
  }
}
