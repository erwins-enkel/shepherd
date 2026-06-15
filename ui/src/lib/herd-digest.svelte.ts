import type { HerdDigest } from "./types";
import { getHerdDigest } from "./api";

/** Client holder for the single latest Herd Rundown digest. Loaded once on app
 *  start; live updates arrive via the `herd:digest` WS event (see store.svelte.ts).
 *  Unlike recaps this is NOT a map — the server only ever pushes the current
 *  (latest) digest, so newest simply replaces. */
class HerdDigestStore {
  digest = $state<HerdDigest | null>(null);
  loaded = $state(false);

  async load() {
    try {
      this.digest = await getHerdDigest();
    } catch {
      /* best-effort; live events still populate */
    } finally {
      this.loaded = true;
    }
  }

  apply(d: { digest: HerdDigest }) {
    this.digest = d.digest;
  }
}
export const herdDigest = new HerdDigestStore();
