// Global, localStorage-backed toggle for the "mine & unassigned" issue filter (#824).
// Shared by both issue surfaces (Backlog IssuesPanel + New Task PromptSources) so the
// preference stays in sync across them and survives reloads. Default ON: the lists hide
// others' issues out of the box. Mirrors build-queue-collapse.svelte.ts, but with an
// inverted default — absence of the key means "on", so off is the value we persist.
const KEY = "shepherd:issues-hide-others";

function read(): boolean {
  try {
    // Default true: only an explicit "0" turns it off.
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

class IssuesFilter {
  hideOthers = $state(read());
  toggle() {
    this.set(!this.hideOthers);
  }
  set(v: boolean) {
    this.hideOthers = v;
    try {
      if (v) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "0");
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const issuesFilter = new IssuesFilter();
