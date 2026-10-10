// "Überblick" button of the Repos dialog's tab row ↔ IssuesPanel's selection. The button lives in
// BacklogTabBar, the selection in IssuesPanel; the path between them (BacklogView →
// BacklogTabContent → IssuesPanel) is the same drilling backlog-refresh.svelte.ts avoids, so this
// is a module singleton too. IssuesPanel mirrors "an entry is selected" into `selected` and acts
// on `nonce` (a monotonic request counter — consumers latch the value they last acted on and
// must not compare against 0, the panel mounts after earlier requests).
class IssuesOverview {
  /** An entry of the Issues list is selected, i.e. the overview is NOT showing. */
  selected = $state(false);
  #nonce = $state(0);
  get nonce(): number {
    return this.#nonce;
  }
  /** Ask the Issues panel to drop its selection and show the repo overview. */
  show() {
    this.#nonce += 1;
  }
}

export const issuesOverview = new IssuesOverview();
