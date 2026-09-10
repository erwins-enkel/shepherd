// Per-device toggle for the issue reference (#1234) shown on a session card, so an
// operator can tell at a glance which backlog issue a session is working (#2244).
// Default ON — a session spawned from an issue names it out of the box; whoever finds
// the extra chip noisy turns it off in Settings → Device. Persisted in localStorage;
// mirrors issues-filter.svelte.ts's inverted-default convention: absence of the key
// means "on", so "0" is the value we persist.
const KEY = "shepherd:hide-card-issue-ref";

function read(): boolean {
  try {
    // Default true: only an explicit "0" turns it off.
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

class IssueRef {
  shown = $state(read());
  toggle() {
    this.set(!this.shown);
  }
  set(v: boolean) {
    this.shown = v;
    try {
      if (v) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "0");
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const issueRef = new IssueRef();
