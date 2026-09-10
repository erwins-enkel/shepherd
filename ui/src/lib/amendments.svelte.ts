import type { TaskAmendment } from "./types";
import { getAmendments } from "./api";
import { setKey } from "./safe-keys";

/** Client cache of operator task amendments keyed by session id (#2225). Loaded once on app
 *  start; live updates arrive via the `session:amendments` WS event (see store.svelte.ts), whose
 *  payload always carries a session's FULL list — so an empty array is a genuine all-clear.
 *
 *  Holds RETRACTED amendments too: the record view shows them struck through, and only the server
 *  filters them out of prompts. Modelled on `recaps.svelte.ts`. */
class AmendmentsStore {
  map = $state<Record<string, TaskAmendment[]>>({});

  async load() {
    try {
      this.map = await getAmendments();
    } catch {
      /* best-effort; live events still populate */
    }
  }

  apply(d: { id: string; amendments: TaskAmendment[] }) {
    this.map = setKey(this.map, d.id, d.amendments);
  }

  /** Every amendment on a session, oldest first (retracted included). */
  forSession(id: string): TaskAmendment[] {
    return this.map[id] ?? [];
  }

  /** The amendments that still stand — what actually reaches the session's prompts. */
  standing(id: string): TaskAmendment[] {
    return this.forSession(id).filter((a) => a.retractedAt == null);
  }

  drop(id: string) {
    if (!(id in this.map)) return;
    const copy = { ...this.map };
    delete copy[id];
    this.map = copy;
  }
}
export const amendments = new AmendmentsStore();
