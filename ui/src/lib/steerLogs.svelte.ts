import { getSteerLog } from "./api";
import { setKey } from "./safe-keys";
import type { SteerLogEntry } from "./types";

/** Module-level steer logs keyed by sessionId, read on demand (GET /api/sessions/:id/steer-log).
 *  There is no push for it: callers refresh when a steer is likely to have happened — the
 *  session's status, CI rollup or PR head moved, or the status panel opened. A failed read keeps
 *  the last log; overlapping refreshes for one session collapse into one request. */
class SteerLogsStore {
  map = $state<Record<string, SteerLogEntry[]>>({});
  #inFlight = new Set<string>();

  async refresh(sessionId: string): Promise<void> {
    if (this.#inFlight.has(sessionId)) return;
    this.#inFlight.add(sessionId);
    try {
      this.map = setKey(this.map, sessionId, await getSteerLog(sessionId));
    } catch {
      // keep the last known log; the next trigger retries
    } finally {
      this.#inFlight.delete(sessionId);
    }
  }
}

export const steerLogs = new SteerLogsStore();
