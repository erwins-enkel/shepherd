/**
 * Spawns the drain sent to other machines (src/drain-placement.ts): how they are keyed, and which
 * of them are still on their way or running there. The pure half — index.ts reads the dispatch rows
 * and the session mirror and asks `remoteWorkOf`.
 *
 * A drain spawn goes out as an ordinary remote dispatch (`RemoteDispatcher.submit`, #2763) whose
 * client key is `drain/<issue>/<uuid>`, so it can be told apart from a task an operator sent and
 * matched to its issue without a table of its own. Its session there is a mirrored reference
 * (#2762): never in this store, so no poller, reaper or retire here touches it — follow-up work
 * stays with that machine.
 *
 * One counts while its start is unconfirmed (`sending`, `unknown`) or held there, and once started
 * while its mirrored session is not archived. A start younger than `START_GRACE_MS` counts even
 * before the mirror shows the session, so a fresh dispatch cannot free its slot for a moment.
 */
import { randomUUID } from "node:crypto";
import type { RemoteDispatchRow } from "./remote-instances/dispatch";
import type { MirroredSession, SessionHost } from "./remote-instances/sessions";

const DRAIN_KEY_RE = /^drain\/(\d+)\//;

/** How long a started dispatch counts without its session in the mirror. */
export const START_GRACE_MS = 5 * 60_000;

/** How far back dispatch rows are read: anything older has long settled. */
export const REMOTE_WORK_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** The client key of a drain spawn for `issue`. */
export function drainDispatchKey(issue: number, id: string = randomUUID()): string {
  return `drain/${issue}/${id}`;
}

/** The issue a drain dispatch key names; null for any other key. */
export function issueOfDrainKey(key: string): number | null {
  const m = DRAIN_KEY_RE.exec(key);
  return m ? Number(m[1]) : null;
}

/** A drain spawn on another machine: where, its session there (null until the start is
 *  confirmed), that session's designation and its PR once it opened one. */
export interface RemoteWork {
  host: SessionHost;
  sessionId: string | null;
  desig: string | null;
  prNumber: number | null;
}

function prNumberOf(session: MirroredSession): number | null {
  const n = session.git?.number;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** The drain spawns still on their way or running elsewhere, by issue: the newest dispatch per
 *  issue decides. `rows` come newest first (`listDrainRemoteDispatches`); `hostOf` names a
 *  registered machine (null once it was removed — its rows no longer count). */
export function remoteWorkOf(
  rows: readonly RemoteDispatchRow[],
  mirrored: readonly MirroredSession[],
  hostOf: (instanceId: string) => SessionHost | null,
  now: number,
): Map<number, RemoteWork> {
  const sessions = new Map(mirrored.map((s) => [s.id, s]));
  const work = new Map<number, RemoteWork>();
  const seen = new Set<number>();
  for (const row of rows) {
    const issue = issueOfDrainKey(row.clientKey);
    if (issue === null || seen.has(issue)) continue;
    seen.add(issue);
    const host = hostOf(row.instanceId);
    if (!host) continue;
    if (row.state !== "started") {
      work.set(issue, { host, sessionId: null, desig: null, prNumber: null });
      continue;
    }
    const session = row.sessionId ? sessions.get(row.sessionId) : undefined;
    if (session) {
      if (session.status === "archived") continue;
      const desig = typeof session.desig === "string" ? session.desig : null;
      work.set(issue, {
        host: session.host,
        sessionId: session.id,
        desig,
        prNumber: prNumberOf(session),
      });
    } else if (now - row.updatedAt < START_GRACE_MS) {
      work.set(issue, { host, sessionId: row.sessionId, desig: null, prNumber: null });
    }
  }
  return work;
}
