import { getSteerLog } from "./api";
import { setKey } from "./safe-keys";
import type { GitState, Session, SteerLogEntry } from "./types";

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
      // Await before reading `this.map`: a read in the synchronous part would subscribe the
      // caller's $effect to the whole map, and each write would re-run it — a request loop (#3170).
      const log = await getSteerLog(sessionId);
      this.map = setKey(this.map, sessionId, log);
    } catch {
      // keep the last known log; the next trigger retries
    } finally {
      this.#inFlight.delete(sessionId);
    }
  }
}

export const steerLogs = new SteerLogsStore();

/** When to re-read a session's steer log: a key that moves whenever a steer is likely to have just
 *  happened — its status, CI rollup or PR head moved. A primitive, so a fresh session object with
 *  the same values doesn't refetch. Null for finished sessions and a mirrored one (#2762), whose
 *  log lives on its own machine. Shared by the card and the detail view. */
export function steerLogRefreshKey(
  session: Pick<Session, "id" | "status" | "host">,
  git: Pick<GitState, "checks" | "headSha"> | null | undefined,
): string | null {
  return session.host || session.status === "done" || session.status === "archived"
    ? null
    : `${session.id}|${session.status}|${git?.checks ?? ""}|${git?.headSha ?? ""}`;
}
