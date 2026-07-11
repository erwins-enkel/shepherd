import type { EpicDraft } from "./types";
import { getEpicDraft } from "./api";

/** Module-level reactive epic-draft map keyed by sessionId (issue #1507).
 *  Driven by two sources:
 *  - WS `session:epic-draft` events (via HerdStore.apply → epicDrafts.upsert)
 *  - An on-demand `load(sessionId)` GET when a draft panel opens (survives a page reload).
 *  Components read from this directly by sessionId without threading the HerdStore as a prop. */
class EpicDraftsStore {
  map = $state<Record<string, EpicDraft>>({});
  /** sessionIds with a load() in flight — avoids duplicate fetches while one is pending. */
  private loading = new Set<string>();

  get(sessionId: string): EpicDraft | undefined {
    return this.map[sessionId];
  }

  upsert(d: EpicDraft) {
    this.map = { ...this.map, [d.sessionId]: d };
  }

  /** Fetch a session's draft once and cache it. No-op if already loaded or a load is in flight;
   *  a subsequent WS event still refreshes it. */
  async load(sessionId: string): Promise<void> {
    if (this.map[sessionId] || this.loading.has(sessionId)) return;
    this.loading.add(sessionId);
    try {
      const d = await getEpicDraft(sessionId);
      if (d) this.upsert(d);
    } catch {
      /* transient — the panel shows its empty state; a WS event will fill it */
    } finally {
      this.loading.delete(sessionId);
    }
  }
}

export const epicDrafts = new EpicDraftsStore();
