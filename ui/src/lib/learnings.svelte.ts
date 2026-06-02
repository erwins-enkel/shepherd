import type { Learning } from "./types";
import { getPendingLearnings } from "./api";

/** Client cache of PROPOSED learnings across all repos. Loaded once on app start;
 *  live updates arrive via the `learnings:update` WS event (see store.svelte.ts),
 *  which triggers a reload. */
class LearningsStore {
  items = $state<Learning[]>([]);

  async load() {
    try {
      this.items = await getPendingLearnings();
    } catch {
      /* best-effort; live events still trigger reloads */
    }
  }

  /** A learnings:update event just signals "something changed" — reload the list. */
  apply(d: { pending: number }) {
    void d; // signal is sufficient — reload fetches fresh count
    void this.load();
  }

  set(items: Learning[]) {
    this.items = items;
  }

  get pending(): number {
    return this.items.length;
  }
}
export const learnings = new LearningsStore();
