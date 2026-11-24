import type { ReviewFeedbackItem, ReviewFeedbackPending } from "./types";
import { getPendingReviewFeedback } from "./api";
import { setKey } from "./safe-keys";

/** Client cache of pending PR review feedback keyed by session id (#4126). Loaded on app start and
 *  on every reconnect; live updates arrive via the `session:review-feedback` WS event (see
 *  store.svelte.ts), whose payload always carries a session's FULL pending list — so an empty
 *  list is a genuine all-clear. Modelled on `amendments.svelte.ts`. */
class ReviewFeedbackStore {
  map = $state<Record<string, ReviewFeedbackPending>>({});

  async load() {
    try {
      this.map = await getPendingReviewFeedback();
    } catch {
      /* best-effort; live events still populate */
    }
  }

  apply(d: { id: string; pending: ReviewFeedbackItem[]; autoPaused: boolean }) {
    if (d.pending.length === 0 && !d.autoPaused) this.drop(d.id);
    else this.map = setKey(this.map, d.id, { items: d.pending, autoPaused: d.autoPaused });
  }

  /** The session's pending items, oldest first; empty when none. */
  items(id: string): ReviewFeedbackItem[] {
    return this.map[id]?.items ?? [];
  }

  /** Automatic sends hit the rolling cap (5 per session per hour). */
  autoPaused(id: string): boolean {
    return this.map[id]?.autoPaused ?? false;
  }

  /** Drop the given items locally after a send or dismiss; the server's event follows. */
  remove(id: string, ids: readonly string[]) {
    const entry = this.map[id];
    if (!entry) return;
    const gone = new Set(ids);
    this.apply({
      id,
      pending: entry.items.filter((i) => !gone.has(i.id)),
      autoPaused: entry.autoPaused,
    });
  }

  drop(id: string) {
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const reviewFeedback = new ReviewFeedbackStore();
