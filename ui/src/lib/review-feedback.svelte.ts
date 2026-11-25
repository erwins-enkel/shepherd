import type { ReviewFeedbackItem, ReviewFeedbackPending } from "./types";
import type { MachineRead } from "./remote-sessions";
import { getPendingReviewFeedback } from "./api";
import { dropKey, setKey } from "./safe-keys";

type FeedbackChange = { id: string; pending: ReviewFeedbackItem[]; autoPaused: boolean };

/** `map` after `d`: an empty, unpaused payload is a genuine all-clear and drops the entry. */
function withChange(
  map: Record<string, ReviewFeedbackPending>,
  d: FeedbackChange,
): Record<string, ReviewFeedbackPending> {
  if (d.pending.length === 0 && !d.autoPaused) return d.id in map ? dropKey(map, d.id) : map;
  return setKey(map, d.id, { items: d.pending, autoPaused: d.autoPaused });
}

/** Client cache of pending PR review feedback keyed by session id (#4126). Loaded on app start and
 *  on every reconnect; live updates arrive via the `session:review-feedback` WS event (see
 *  store.svelte.ts), whose payload always carries a session's FULL pending list — so an empty
 *  list is a genuine all-clear. Modelled on `amendments.svelte.ts`. Sessions mirrored from a
 *  connected machine (#4139) live in `remote`, seeded per machine and fed by relayed frames, so a
 *  local `load()` never touches them. */
class ReviewFeedbackStore {
  map = $state<Record<string, ReviewFeedbackPending>>({});
  remote = $state<Record<string, ReviewFeedbackPending>>({});
  /** Last snapshot read key per machine instance ID (see {@link syncMachines}). */
  #readKeys = new Map<string, string>();

  async load() {
    try {
      this.map = await getPendingReviewFeedback();
    } catch {
      /* best-effort; live events still populate */
    }
  }

  apply(d: FeedbackChange) {
    this.map = withChange(this.map, d);
  }

  /** A relayed frame for a mirrored session. */
  applyRemote(d: FeedbackChange) {
    this.remote = withChange(this.remote, d);
  }

  /** Read each machine's snapshot once per read key; `idsOf` names the machine's mirrored
   *  sessions when the answer lands, and only those entries are replaced. A failed read is
   *  retried on the next key change of any machine. */
  syncMachines(reads: MachineRead[], idsOf: (instanceId: string) => string[]) {
    for (const { instanceId, key } of reads) {
      if (this.#readKeys.get(instanceId) === key) continue;
      this.#readKeys.set(instanceId, key);
      getPendingReviewFeedback(instanceId)
        .then((map) => {
          if (this.#readKeys.get(instanceId) === key) this.#seedRemote(map, idsOf(instanceId));
        })
        .catch(() => {
          if (this.#readKeys.get(instanceId) === key) this.#readKeys.delete(instanceId);
        });
    }
  }

  #seedRemote(map: Record<string, ReviewFeedbackPending>, ids: string[]) {
    let next = this.remote;
    for (const id of ids) {
      const entry = Object.hasOwn(map, id) ? map[id] : undefined;
      if (entry) next = setKey(next, id, entry);
      else if (id in next) next = dropKey(next, id);
    }
    this.remote = next;
  }

  /** Forget mirrored sessions that left the list. */
  pruneRemote(liveIds: string[]) {
    const live = new Set(liveIds);
    let next = this.remote;
    for (const id of Object.keys(next)) if (!live.has(id)) next = dropKey(next, id);
    if (next !== this.remote) this.remote = next;
  }

  /** The session's pending items, oldest first; empty when none. */
  items(id: string): ReviewFeedbackItem[] {
    return (this.map[id] ?? this.remote[id])?.items ?? [];
  }

  /** Automatic sends hit the rolling cap (5 per session per hour). */
  autoPaused(id: string): boolean {
    return (this.map[id] ?? this.remote[id])?.autoPaused ?? false;
  }

  drop(id: string) {
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const reviewFeedback = new ReviewFeedbackStore();
