import type { UpNextSnapshot } from "./types";
import { getUpNext } from "./api";

/** Client holder for the latest Up Next snapshot (#1169). Loaded once on app start;
 *  live updates arrive via the `upnext:snapshot` WS event (see store.svelte.ts). The
 *  server only ever pushes the current snapshot, so newest simply replaces. */
class UpNextStore {
  snapshot = $state<UpNextSnapshot | null>(null);
  loaded = $state(false);

  async load() {
    try {
      this.snapshot = await getUpNext();
    } catch {
      /* best-effort; live events still populate */
    } finally {
      this.loaded = true;
    }
  }

  apply(d: { snapshot: UpNextSnapshot }) {
    this.snapshot = d.snapshot;
  }
}
export const upNext = new UpNextStore();
