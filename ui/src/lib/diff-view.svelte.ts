// Persisted split/unified preference for the multi-file diff tab. The stored
// `pref` is the operator's choice; the *resolved* value is what the panel keys
// on — narrow viewports (phone/split-screen) force unified regardless of pref,
// because side-by-side split can't fit. Mirrors the shape of
// build-queue-collapse.svelte.ts (localStorage read/try-catch + `set`) and
// theme.svelte.ts (matchMedia-tracked `$state` seeded at construction, updated
// via an `init()`-registered change listener that returns a disposer).

export type DiffViewPref = "split" | "unified";

const KEY = "shepherd:diff-view";
const NARROW_QUERY = "(max-width: 768px)";

function read(): DiffViewPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "split" || v === "unified") return v;
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
  }
  return "split";
}

function narrowNow(): boolean {
  return typeof matchMedia !== "undefined" ? matchMedia(NARROW_QUERY).matches : false;
}

class DiffViewPrefStore {
  pref = $state<DiffViewPref>(read());
  narrow = $state<boolean>(narrowNow());

  /** Effective view: unified is forced on a narrow viewport; otherwise `pref`.
   *  A getter (not `$derived`) so it recomputes on every read — reactive in a
   *  component because it reads the `$state` fields, and stable in node tests. */
  get resolved(): DiffViewPref {
    return this.narrow ? "unified" : this.pref;
  }

  /** Persist + apply a new stored preference. */
  set(v: DiffViewPref) {
    this.pref = v;
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode / SSR — preference just won't survive reload */
    }
  }

  toggle() {
    this.set(this.pref === "split" ? "unified" : "split");
  }

  /** Wire viewport-width changes. Call once on mount; returns a disposer.
   *  SSR-guarded like theme.svelte.ts's dark-query listener. */
  init(): () => void {
    if (typeof matchMedia === "undefined") return () => {};
    const mq = matchMedia(NARROW_QUERY);
    this.narrow = mq.matches;
    const onChange = () => {
      this.narrow = mq.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }
}

export const diffView = new DiffViewPrefStore();
export { read as readDiffView };
