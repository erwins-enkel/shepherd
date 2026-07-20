import { listIssues } from "$lib/api";
import type { Issue } from "$lib/types";
import { viewerCache } from "$lib/viewer-cache.svelte";

/**
 * Single issue-data owner for the New Task modal: PromptSources' panel and the inline
 * `#` IssueSearchMenu render from ONE instance, so a repo selection issues exactly one
 * listIssues call shared by both (one fetch per selection generation).
 *
 * Generation-safe: every load() bumps a monotonic generation and a resolution applies
 * only when its captured generation is still current — this subsumes a path comparison
 * and closes the A→B→A clobber (an old A response arriving after the return to A).
 *
 * Failure semantics mirror PromptSources' previous inline load: local state resets
 * (loadError distinguishable from a genuine zero-open-issues success via `slug`), but
 * the viewerCache entry is deliberately NOT evicted — it is session-lived last-known-good
 * so a transient reload failure never silently disables the assigned-others notice.
 */
export class IssueData {
  issues = $state<Issue[]>([]);
  slug = $state<string | null>(null);
  viewer = $state<string | null>(null);
  loading = $state(false);
  /** True when the fetch failed OR a partial success carried an error alongside issues. */
  loadError = $state(false);

  #generation = 0;

  load(repoPath: string): void {
    const gen = ++this.#generation;
    this.issues = [];
    this.slug = null;
    this.viewer = null;
    this.loadError = false;
    if (!repoPath) {
      this.loading = false;
      return;
    }
    this.loading = true;
    listIssues(repoPath)
      .then((r) => {
        if (gen !== this.#generation) return;
        this.slug = r.slug;
        this.issues = r.issues;
        this.viewer = r.viewer;
        viewerCache.set(repoPath, r.viewer);
        this.loadError = r.error != null;
        this.loading = false;
      })
      .catch(() => {
        if (gen !== this.#generation) return;
        this.slug = null;
        this.issues = [];
        this.viewer = null;
        this.loadError = true;
        this.loading = false;
      });
  }
}
