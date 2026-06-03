import type { ReviewVerdict, RepoConfig } from "./types";
import { getReviews, getReviewingIds, getRepoConfig, putRepoConfig } from "./api";

/** Client cache of critic verdicts keyed by session id. Loaded once on app start;
 *  live updates arrive via the `session:review` WS event (see store.svelte.ts). */
class ReviewsStore {
  map = $state<Record<string, ReviewVerdict>>({});
  // session ids with a critic run currently in flight; driven by `session:reviewing`
  reviewing = $state<Record<string, boolean>>({});

  async load() {
    try {
      this.map = await getReviews();
    } catch {
      /* best-effort; live events still populate it */
    }
    try {
      // bootstrap in-flight runs so a reload mid-review still shows the indicator
      this.reviewing = Object.fromEntries((await getReviewingIds()).map((id) => [id, true]));
    } catch {
      /* best-effort; `session:reviewing` events still populate it */
    }
  }

  apply(d: { id: string; review: ReviewVerdict | null }) {
    if (d.review) this.map = { ...this.map, [d.id]: d.review };
    else {
      const copy = { ...this.map };
      delete copy[d.id];
      this.map = copy;
    }
    // a verdict (or its removal) means the run is no longer in flight
    this.setReviewing(d.id, false);
  }

  setReviewing(id: string, on: boolean) {
    if (!!this.reviewing[id] === on) return;
    if (on) this.reviewing = { ...this.reviewing, [id]: true };
    else {
      const copy = { ...this.reviewing };
      delete copy[id];
      this.reviewing = copy;
    }
  }

  isReviewing(id: string): boolean {
    return !!this.reviewing[id];
  }

  drop(id: string) {
    this.setReviewing(id, false);
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const reviews = new ReviewsStore();

/** Per-repo critic + auto-address + learnings on/off, cached lazily by repoPath. */
class RepoConfigStore {
  enabled = $state<Record<string, boolean>>({}); // critic on/off (default on)
  autoAddress = $state<Record<string, boolean>>({}); // auto-address loop on/off (default off)
  learnings = $state<Record<string, boolean>>({}); // house-rule injection (default on)

  async ensure(repoPath: string) {
    if (repoPath in this.enabled) return;
    try {
      const c = await getRepoConfig(repoPath);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
      this.autoAddress = { ...this.autoAddress, [repoPath]: c.autoAddressEnabled };
      this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
    } catch {
      /* leave unset; UI shows defaults (critic on, auto-address off, learnings on) optimistically */
    }
  }

  /** Optimistically apply a patch, then reconcile from the server (or revert on error). */
  private async apply(
    repoPath: string,
    patch: Partial<Pick<RepoConfig, "criticEnabled" | "autoAddressEnabled" | "learningsEnabled">>,
    revert: () => void,
  ) {
    try {
      const c = await putRepoConfig(repoPath, patch);
      this.enabled = { ...this.enabled, [repoPath]: c.criticEnabled };
      this.autoAddress = { ...this.autoAddress, [repoPath]: c.autoAddressEnabled };
      this.learnings = { ...this.learnings, [repoPath]: c.learningsEnabled };
    } catch {
      revert();
    }
  }

  async toggle(repoPath: string) {
    const prev = this.enabled[repoPath];
    const next = !this.isEnabled(repoPath);
    this.enabled = { ...this.enabled, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { criticEnabled: next }, () => {
      this.enabled = { ...this.enabled, [repoPath]: prev };
    });
  }

  async toggleAutoAddress(repoPath: string) {
    const prev = this.autoAddress[repoPath];
    const next = !this.isAutoAddressEnabled(repoPath);
    this.autoAddress = { ...this.autoAddress, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { autoAddressEnabled: next }, () => {
      this.autoAddress = { ...this.autoAddress, [repoPath]: prev };
    });
  }

  async toggleLearnings(repoPath: string) {
    const prev = this.learnings[repoPath];
    const next = !this.learningsOn(repoPath);
    this.learnings = { ...this.learnings, [repoPath]: next }; // optimistic
    await this.apply(repoPath, { learningsEnabled: next }, () => {
      this.learnings = { ...this.learnings, [repoPath]: prev };
    });
  }

  isEnabled(repoPath: string): boolean {
    return this.enabled[repoPath] ?? true;
  }

  isAutoAddressEnabled(repoPath: string): boolean {
    return this.autoAddress[repoPath] ?? false;
  }

  learningsOn(repoPath: string): boolean {
    return this.learnings[repoPath] ?? true;
  }
}
export const repoConfig = new RepoConfigStore();
