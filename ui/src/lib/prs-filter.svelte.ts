// Global, localStorage-backed toggles for the PRs-tab filters (hide drafts / hide
// conflicts / hide failed CI). Mirrors issues-filter.svelte.ts so the PR view's
// preferences survive reloads and stay in sync wherever the PRs list is shown.
// All three default OFF — absence of a key means "off", so "1" is the value we
// persist when a toggle is ON (hiding is opt-in; hiding conflicting/failing PRs
// out of the box would surprise). The repo-scoped author filter is NOT here — its
// option set is repo-specific, so it lives as local component state (see PrsPanel).
const KEY_DRAFTS = "shepherd:prs-hide-drafts";
const KEY_CONFLICTS = "shepherd:prs-hide-conflicts";
const KEY_FAILING_CI = "shepherd:prs-hide-failing-ci";

function read(key: string): boolean {
  try {
    // Default false: only an explicit "1" turns it on.
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* private mode / SSR — preference just won't survive reload */
  }
}

class PrsFilter {
  hideDrafts = $state(read(KEY_DRAFTS));
  hideConflicts = $state(read(KEY_CONFLICTS));
  hideFailingCi = $state(read(KEY_FAILING_CI));

  toggleDrafts() {
    this.setDrafts(!this.hideDrafts);
  }
  setDrafts(v: boolean) {
    this.hideDrafts = v;
    write(KEY_DRAFTS, v);
  }

  toggleConflicts() {
    this.setConflicts(!this.hideConflicts);
  }
  setConflicts(v: boolean) {
    this.hideConflicts = v;
    write(KEY_CONFLICTS, v);
  }

  toggleFailingCi() {
    this.setFailingCi(!this.hideFailingCi);
  }
  setFailingCi(v: boolean) {
    this.hideFailingCi = v;
    write(KEY_FAILING_CI, v);
  }
}

export const prsFilter = new PrsFilter();
