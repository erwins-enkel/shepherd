const KEY = "shepherd:sidebar-collapsed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Pure gate: collapse the sidebar only on touch-primary wide devices that have
 *  opted in. No runes / no DOM — directly unit-testable. `touch` = coarse pointer,
 *  `mobile` = ≤768px breakpoint, `collapsed` = the persisted user choice. */
export function sidebarShouldCollapse(
  touch: boolean,
  mobile: boolean,
  collapsed: boolean,
): boolean {
  return touch && !mobile && collapsed;
}

class SidebarCollapse {
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

export const sidebarCollapse = new SidebarCollapse();
