import type { Learning, RepoInjectable, DistillerHealth, MergeSuggestion } from "./types";
import {
  getPendingLearnings,
  getInjectableLearnings,
  getLearningsHealth,
  getMergeSuggestions,
} from "./api";

/** Client cache of PROPOSED learnings (across all repos) plus the per-repo
 *  INJECTABLE view (active/promoted rules + budget meter). Loaded once on app
 *  start; live updates arrive via the `learnings:update` WS event (see
 *  store.svelte.ts), which triggers a reload of both. */
class LearningsStore {
  items = $state<Learning[]>([]);
  injectable = $state<RepoInjectable[]>([]);
  mergeSuggestions = $state<MergeSuggestion[]>([]);
  health = $state<DistillerHealth>({ ok: true, consecutiveFailures: 0, lastFailure: null });

  async load() {
    // Independent best-effort fetches: a failure in one must not blank the other.
    await Promise.all([
      getPendingLearnings()
        .then((v) => (this.items = v))
        .catch(() => {
          /* best-effort; live events still trigger reloads */
        }),
      getInjectableLearnings()
        .then((v) => (this.injectable = v))
        .catch(() => {
          /* best-effort */
        }),
      getMergeSuggestions()
        .then((v) => (this.mergeSuggestions = v))
        .catch(() => {
          /* best-effort */
        }),
      getLearningsHealth()
        .then((v) => (this.health = v))
        .catch(() => {
          /* best-effort */
        }),
    ]);
  }

  /** A learnings:update event just signals "something changed" — reload the lists. */
  apply(d: { pending: number }) {
    void d; // signal is sufficient — reload fetches fresh state
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
