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

/** A live mirrored session as drain work there. */
function sessionWork(session: MirroredSession): RemoteWork {
  return {
    host: session.host,
    sessionId: session.id,
    desig: typeof session.desig === "string" ? session.desig : null,
    prNumber: prNumberOf(session),
  };
}

/** One dispatch's work on `host`, or null when it no longer counts. */
function rowWork(
  row: RemoteDispatchRow,
  host: SessionHost,
  session: MirroredSession | undefined,
  now: number,
): RemoteWork | null {
  if (row.state !== "started") return { host, sessionId: null, desig: null, prNumber: null };
  if (session) return session.status === "archived" ? null : sessionWork(session);
  const fresh = now - row.updatedAt < START_GRACE_MS;
  return fresh ? { host, sessionId: row.sessionId, desig: null, prNumber: null } : null;
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
    const found = host && rowWork(row, host, sessions.get(row.sessionId ?? ""), now);
    if (found) work.set(issue, found);
  }
  return work;
}
