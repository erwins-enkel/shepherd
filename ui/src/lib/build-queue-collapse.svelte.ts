const KEY = "shepherd:build-queue-collapsed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

class BuildQueueCollapse {
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

export const buildQueueCollapse = new BuildQueueCollapse();
export { read as readBuildQueueCollapse };
