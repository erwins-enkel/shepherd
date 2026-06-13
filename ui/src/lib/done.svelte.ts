import type { Session } from "./types";
import { getDoneSessions } from "./api";

/** Lazy client store of recently-archived ("done") sessions, populated on demand
 *  when the Done lens opens. It holds only the session list — recap content lives in
 *  the shared `recaps` store and updates via the `session:recap` WS event there, so
 *  this store deliberately subscribes to no WS events. */
class DoneSessionsStore {
  sessions = $state<Session[]>([]);

  /** Re-fetches every call; the Done lens reloads on each open (see +page.svelte) so the
   *  list reflects sessions that finished since last time. On failure it leaves the
   *  existing list untouched and swallows the error — the next open retries. */
  async load() {
    try {
      this.sessions = await getDoneSessions();
    } catch {
      /* best-effort; the next lens open retries */
    }
  }
}
export const doneSessions = new DoneSessionsStore();
