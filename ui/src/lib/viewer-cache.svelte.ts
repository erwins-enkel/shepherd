import { SvelteMap } from "svelte/reactivity";

/**
 * Per-repo forge viewer (the `currentUser` login), cached from `listIssues()`
 * resolves (#1694). Some surfaces need the viewer but can't resolve it themselves:
 * the New Task dialog opens on the To-Do tab, so its embedded PromptSources only
 * fetches the viewer once the Issues tab is visited — too late for a `+ Task` that
 * arrives with an issue pre-attached. Whoever already calls `listIssues`
 * (IssuesPanel, PromptSources) writes the viewer here; NewTask reads it by repoPath.
 *
 * Backed by a reactive `SvelteMap`, so a late cross-component write (PromptSources
 * resolving the viewer after the dialog is open) re-renders NewTask's derived notice.
 * A missing entry ("cold") reads as `null` — viewer unknown for that repo — and every
 * caller fails closed (no "assigned to others" claim) in that case.
 */
class ViewerCache {
  #byRepo = new SvelteMap<string, string | null>();

  /** Record the resolved viewer (or null) for a repo, from a `listIssues` result. */
  set(repoPath: string, viewer: string | null): void {
    this.#byRepo.set(repoPath, viewer);
  }

  /** The cached viewer for a repo, or null when never resolved (cold) / unknown. */
  get(repoPath: string): string | null {
    return this.#byRepo.get(repoPath) ?? null;
  }
}

export const viewerCache = new ViewerCache();
