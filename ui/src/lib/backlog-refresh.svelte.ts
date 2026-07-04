// Global soft-refresh signal for the backlog drawer's one-shot caches (IssuesPanel's
// issues + epic summaries + expanded-epic fetches). +page's resync() bumps it on tab
// wake and on socket re-open; IssuesPanel watches the nonce and refetches WITHOUT
// resetting operator state (filter text, expanded rows). A module singleton — not a
// prop — because the drilling path (+page → AppOverlays → BacklogOverlay → BacklogView
// → BacklogTabContent → IssuesPanel) spans six files and IssuesPanel already imports
// issuesFilter/steers/repos the same way. The nonce is page-lifetime and monotonic;
// consumers must latch the value they last acted on (NOT compare against 0), since
// the {#if}-mounted drawer routinely mounts after earlier bumps.
class BacklogRefresh {
  #nonce = $state(0);
  get nonce(): number {
    return this.#nonce;
  }
  bump() {
    this.#nonce += 1;
  }
}

export const backlogRefresh = new BacklogRefresh();
