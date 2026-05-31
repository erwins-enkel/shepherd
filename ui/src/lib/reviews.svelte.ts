import type { ReviewVerdict } from "./types";
import { getReviews, getRepoConfig, putRepoConfig } from "./api";

/** Client cache of critic verdicts keyed by session id. Loaded once on app start;
 *  live updates arrive via the `session:review` WS event (see store.svelte.ts). */
class ReviewsStore {
  map = $state<Record<string, ReviewVerdict>>({});

  async load() {
    try {
      this.map = await getReviews();
    } catch {
      /* best-effort; live events still populate it */
    }
  }

  apply(d: { id: string; review: ReviewVerdict | null }) {
    if (d.review) this.map = { ...this.map, [d.id]: d.review };
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
export const reviews = new ReviewsStore();

/** Per-repo critic on/off, cached lazily by repoPath. */
class RepoConfigStore {
  enabled = $state<Record<string, boolean>>({});

  async ensure(repoPath: string) {
    if (repoPath in this.enabled) return;
    try {
      const c = await getRepoConfig(repoPath);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
    } catch {
      /* leave unset; UI shows default-on optimistically */
    }
  }

  async toggle(repoPath: string) {
    const next = !(this.enabled[repoPath] ?? true);
    this.enabled = { ...this.enabled, [repoPath]: next }; // optimistic
    try {
      const c = await putRepoConfig(repoPath, next);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
    } catch {
      this.enabled = { ...this.enabled, [repoPath]: !next }; // revert
    }
  }

  isEnabled(repoPath: string): boolean {
    return this.enabled[repoPath] ?? true;
  }
}
export const repoConfig = new RepoConfigStore();
