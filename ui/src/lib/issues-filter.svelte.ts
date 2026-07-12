// Global, localStorage-backed toggle for the "mine & unassigned" issue filter (#824).
// Shared by both issue surfaces (Backlog IssuesPanel + New Task PromptSources) so the
// preference stays in sync across them and survives reloads. Default ON: the lists hide
// others' issues out of the box. Mirrors build-queue-collapse.svelte.ts, but with an
// inverted default — absence of the key means "on", so off is the value we persist.
const KEY = "shepherd:issues-hide-others";
// "Hide in progress" filter: drop issues labeled shepherd:active (claimed by a
// running session). Independent of hideOthers, viewer-agnostic, and default OFF —
// absence of the key means "off", so on is the value we persist ("1").
const KEY_ACTIVE = "shepherd:issues-hide-active";
// "Hide sub-issues" filter: drop native sub-issues (children of an epic). Default ON —
// absence of the key means "on", so "0" is the value we persist.
const KEY_SUB = "shepherd:issues-hide-subissues";
// "Hide blocked" filter: drop issues whose labels mark them blocked (see isBlocked in
// issues-panel.ts). Default ON — absence of the key means "on", so "0" is the value we persist.
const KEY_BLOCKED = "shepherd:issues-hide-blocked";

function read(): boolean {
  try {
    // Default true: only an explicit "0" turns it off.
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

function readActive(): boolean {
  try {
    // Default false: only an explicit "1" turns it on.
    return localStorage.getItem(KEY_ACTIVE) === "1";
  } catch {
    return false;
  }
}

function readSub(): boolean {
  try {
    // Default true: only an explicit "0" turns it off.
    return localStorage.getItem(KEY_SUB) !== "0";
  } catch {
    return true;
  }
}

function readBlocked(): boolean {
  try {
    // Default true: only an explicit "0" turns it off.
    return localStorage.getItem(KEY_BLOCKED) !== "0";
  } catch {
    return true;
  }
}

class IssuesFilter {
  hideOthers = $state(read());
  hideActive = $state(readActive());
  hideSubIssues = $state(readSub());
  hideBlocked = $state(readBlocked());
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
  toggleActive() {
    this.setActive(!this.hideActive);
  }
  setActive(v: boolean) {
    this.hideActive = v;
    try {
      if (v) localStorage.setItem(KEY_ACTIVE, "1");
      else localStorage.removeItem(KEY_ACTIVE);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
  toggleSubIssues() {
    this.setSubIssues(!this.hideSubIssues);
  }
  setSubIssues(v: boolean) {
    this.hideSubIssues = v;
    try {
      if (v) localStorage.removeItem(KEY_SUB);
      else localStorage.setItem(KEY_SUB, "0");
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
  toggleBlocked() {
    this.setBlocked(!this.hideBlocked);
  }
  setBlocked(v: boolean) {
    this.hideBlocked = v;
    try {
      if (v) localStorage.removeItem(KEY_BLOCKED);
      else localStorage.setItem(KEY_BLOCKED, "0");
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const issuesFilter = new IssuesFilter();
