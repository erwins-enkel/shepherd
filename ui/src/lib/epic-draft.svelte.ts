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

  /** Plain observers, notified on every upsert. Rendering reads `map` reactively; this is for logic
   *  that must react to a draft's state OUTSIDE the component tree and outlive it — see
   *  `epic-approve.ts`, which reports the outcome of an approve whose response was lost long after
   *  the modal that started it has closed. */
  private listeners = new Set<(d: EpicDraft) => void>();

  /** Observe every upserted draft (WS event or GET). Returns an unsubscribe. */
  onUpsert(fn: (d: EpicDraft) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  upsert(d: EpicDraft) {
    this.map = { ...this.map, [d.sessionId]: d };
    for (const fn of this.listeners) fn(d);
  }

  /** Force a re-GET of a session's draft and upsert it, returning the authoritative row (`null` when
   *  the session has none). Unlike {@link load} this never short-circuits on the cache — the caller
   *  needs the SERVER's current state, not what the store happens to hold.
   *
   *  Used to reconcile a failed-looking approve: the request's connection can die (a severed socket,
   *  a proxy 502) while the handler runs on to completion, so a "failure" in the client may be a
   *  success on the server. The local store can't answer that — the WS `session:epic-draft` event
   *  only fires when the handler FINISHES, strictly after the connection died, and the
   *  draft→materializing transition emits no event at all — so at reconcile time the store still
   *  holds the stale pre-approve row. Only a fresh GET knows.
   *
   *  The GET can still LOSE a race, though: if the handler finishes while it is in flight, the WS
   *  event carrying the terminal state (`approved` / reverted `draft`) may be applied first, and
   *  writing this older response over it would pin the panel on `materializing` forever — no further
   *  event is coming. So a write to THIS session that landed during the GET wins, and we return what
   *  the store now holds.
   *
   *  The guard compares this session's ROW IDENTITY, not a global write counter: every write replaces
   *  `map` wholesale, so a counter (or a `map` reference check) would also trip on an unrelated
   *  session's event — discarding a perfectly good response and reporting a stale `draft` row as a
   *  failure for an approve that is still materializing and about to succeed. */
  async refresh(sessionId: string): Promise<EpicDraft | null> {
    const before = this.map[sessionId];
    const d = await getEpicDraft(sessionId);
    // Overtaken by a newer write to this session (WS event / eviction) — don't clobber it.
    if (this.map[sessionId] !== before) return this.map[sessionId] ?? null;

    if (d) this.upsert(d);
    // `null` is authoritative too: the server says this session has no draft. Drop the cached row —
    // keeping it would leave the panel rendering a stale draft (approve button and all) next to the
    // failure toast explaining that it's gone.
    else this.remove(sessionId);
    return d;
  }

  /** Forget a session's cached draft. */
  remove(sessionId: string) {
    if (!(sessionId in this.map)) return;
    const next = { ...this.map };
    delete next[sessionId];
    this.map = next;
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
