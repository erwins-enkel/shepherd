import type { UpNextSnapshot } from "./types";
import { getUpNext } from "./api";

/** Client holder for the latest Up Next snapshot (#1169). Loaded once on app start;
 *  live updates arrive via the `upnext:snapshot` WS event (see store.svelte.ts). The
 *  server only ever pushes the current snapshot, so newest simply replaces. */
class UpNextStore {
  snapshot = $state<UpNextSnapshot | null>(null);
  loaded = $state(false);
  /** The GET itself failed (herdr down / non-2xx). Distinct from an empty snapshot so the lens
   *  surfaces a load error rather than hanging on "loading" or implying an empty queue (#1221). */
  loadError = $state(false);

  /** Load the snapshot. `peek` (app-load) paints the cached snapshot only; the default
   *  (lens-open) lets the server kick a recompute that lands in place via WS. */
  async load(opts?: { peek?: boolean }) {
    this.loadError = false;
    try {
      this.snapshot = await getUpNext(opts);
    } catch {
      // best-effort; live events may still populate, but flag it so the lens shows the failure
      this.loadError = true;
    } finally {
      this.loaded = true;
    }
  }

  apply(d: { snapshot: UpNextSnapshot }) {
    this.snapshot = d.snapshot;
    this.loadError = false; // a fresh server push supersedes a prior failed fetch
  }
}
export const upNext = new UpNextStore();
