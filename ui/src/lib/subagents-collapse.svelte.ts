const KEY = "shepherd:subagents-collapsed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Global (all sessions) collapse state of the Chat tab's Sub-agents list. */
class SubagentsCollapse {
  collapsed = $state(read());
  toggle() {
    this.set(!this.collapsed);
  }
  set(v: boolean) {
    this.collapsed = v;
    try {
      if (v) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }
}

export const subagentsCollapse = new SubagentsCollapse();
export { read as readSubagentsCollapse };
