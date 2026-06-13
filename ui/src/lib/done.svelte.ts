import type { Session } from "./types";
import { getDoneSessions } from "./api";

/** Lazy client store of recently-archived ("done") sessions, populated on demand
 *  when the Done lens opens. It holds only the session list — recap content lives in
 *  the shared `recaps` store and updates via the `session:recap` WS event there, so
 *  this store deliberately subscribes to no WS events. */
class DoneSessionsStore {
  sessions = $state<Session[]>([]);
  loaded = $state(false);

  async load() {
    try {
      this.sessions = await getDoneSessions();
      this.loaded = true;
    } catch {
      /* best-effort; leaves the list empty + loaded=false so a retry is possible */
    }
  }
}
export const doneSessions = new DoneSessionsStore();
