// Read model of the host-wide heavy-check slot (#3181) as the overview renders it. Only the shape
// and a "switched off" default live here; whatever enforces the slot supplies the real snapshot.

import { DISABLED_HEAVY_SLOT as disabledSnapshot } from "./heavy-slot-default";
import { captureRevision, type HeavySlotRevision, isStale } from "./heavy-slot-revision";
import type { HeavyJob } from "./heavy-slot-core";
import type { SessionStore } from "./store";

export interface HeavySlotHolder {
  sessionId: string;
  /** What is running, e.g. `vitest run`. */
  command: string;
  startedAt: number;
  /** Summed RSS of the holder's process tree (an upper bound — shared pages count repeatedly). */
  rssBytes: number | null;
}

export interface HeavySlotWaiter {
  sessionId: string;
  /** 1-based place in the queue. */
  position: number;
  reason: "slot" | "pressure";
}

export interface HeavySlotPressure {
  ramAvailableBytes: number | null;
  ramTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  /** Memory PSI `full` avg10, percent. */
  memFullAvg10: number | null;
  /** The brake's threshold for `memFullAvg10`, percent. */
  memBrakeThreshold: number | null;
  /** CPU PSI `some` avg10, percent. */
  cpuSomeAvg10: number | null;
}

export interface HeavySlotMemoryBySource {
  agentsBytes: number | null;
  foreignBytes: number | null;
  foreignTop: Array<{ name: string; bytes: number }>;
}

/** The latest finished slot job of a session, bound to the revision it ran against (#3554). */
export interface HeavySlotLastResult {
  sessionId: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  result: "passed" | "failed" | "aborted";
  /** Full commit the job ran on; null when unknown. */
  head: string | null;
  /** Hash of the dirty worktree at job start. */
  treeHash: string;
  /** The worktree no longer matches `head` + `treeHash` (or that could not be told). */
  stale: boolean;
}

export interface HeavySlotSnapshot {
  /** Master switch. Off → the overview shows no chip and no strip. */
  enabled: boolean;
  capacity: number;
  holders: HeavySlotHolder[];
  waiters: HeavySlotWaiter[];
  brake: { active: boolean; reason: "memory" | null };
  pressure: HeavySlotPressure;
  memoryBySource: HeavySlotMemoryBySource;
  lastResults: HeavySlotLastResult[];
}

/** What the slot owner exposes to the server. */
export interface HeavySlotSource {
  snapshot(): HeavySlotSnapshot;
  /** Manually free a holder's slot; false when that session holds none. */
  release(sessionId: string): boolean | Promise<boolean>;
}

export const DISABLED_HEAVY_SLOT: HeavySlotSnapshot = disabledSnapshot;

const REVISION_CACHE_MS = 2000;
const revisionCache = new Map<string, { at: number; rev: Promise<HeavySlotRevision> }>();

function currentRevision(repoPath: string, path: string, now: number): Promise<HeavySlotRevision> {
  for (const [k, v] of revisionCache) if (now - v.at >= REVISION_CACHE_MS) revisionCache.delete(k);
  const hit = revisionCache.get(path);
  if (hit && now - hit.at < REVISION_CACHE_MS) return hit.rev;
  const rev = captureRevision(path, repoPath);
  revisionCache.set(path, { at: now, rev });
  return rev;
}

function lastResultFromJob(job: HeavyJob, current: HeavySlotRevision): HeavySlotLastResult {
  return {
    sessionId: job.sessionId,
    command: job.command,
    startedAt: job.startedAt ?? job.enqueuedAt,
    endedAt: job.finishedAt,
    exitCode: job.exitCode,
    result: job.exitCode === null ? "aborted" : job.exitCode === 0 ? "passed" : "failed",
    head: job.head,
    treeHash: job.treeHash ?? "",
    stale: isStale({ head: job.head, treeHash: job.treeHash ?? "" }, current),
  };
}

/** Each live session's latest finished job, marked stale when its worktree moved on since the job
 *  began. Archived sessions are skipped: their results no longer concern the operator. */
export async function readLastResults(
  store: Pick<SessionStore, "get" | "lastHeavySlotResults">,
  now = Date.now(),
): Promise<HeavySlotLastResult[]> {
  const results = await Promise.all(
    store.lastHeavySlotResults().map(async (job) => {
      const session = store.get(job.sessionId);
      if (!session || session.archivedAt != null) return null;
      const current = await currentRevision(session.repoPath, session.worktreePath, now);
      return lastResultFromJob(job, current);
    }),
  );
  return results.filter((r) => r !== null);
}

/** Most holders / waiters / foreign processes taken from a connected machine's snapshot. */
const REMOTE_LIST_MAX = 64;
const REMOTE_TEXT_MAX = 256;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const orNull = (v: unknown): number | null => (finite(v) ? v : null);
const rec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null =>
  typeof v === "string" ? v.slice(0, REMOTE_TEXT_MAX) : null;

function parseHolder(h: unknown): HeavySlotHolder | null {
  if (!rec(h) || !finite(h.startedAt)) return null;
  const sessionId = text(h.sessionId);
  const command = text(h.command);
  if (sessionId === null || command === null) return null;
  return { sessionId, command, startedAt: h.startedAt, rssBytes: orNull(h.rssBytes) };
}

function parseWaiter(w: unknown): HeavySlotWaiter | null {
  if (!rec(w) || !finite(w.position)) return null;
  const sessionId = text(w.sessionId);
  if (sessionId === null) return null;
  return { sessionId, position: w.position, reason: w.reason === "pressure" ? "pressure" : "slot" };
}

function parseForeign(f: unknown): { name: string; bytes: number } | null {
  if (!rec(f) || !finite(f.bytes)) return null;
  const name = text(f.name);
  return name === null ? null : { name, bytes: f.bytes };
}

/** Up to `REMOTE_LIST_MAX` entries of `raw` that `parse` accepts. */
function parseList<T>(raw: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, REMOTE_LIST_MAX)
    .map(parse)
    .filter((v): v is T => v !== null);
}

function parseLastResult(r: unknown): HeavySlotLastResult | null {
  if (!rec(r) || !finite(r.startedAt)) return null;
  const sessionId = text(r.sessionId);
  const command = text(r.command);
  const treeHash = text(r.treeHash);
  if (sessionId === null || command === null || treeHash === null) return null;
  const result = r.result === "passed" || r.result === "failed" ? r.result : "aborted";
  return {
    sessionId,
    command,
    startedAt: r.startedAt,
    endedAt: orNull(r.endedAt),
    exitCode: typeof r.exitCode === "number" && Number.isInteger(r.exitCode) ? r.exitCode : null,
    result,
    head: text(r.head),
    treeHash,
    // Another host's worktree can't be compared from here: only an explicit `false` counts as current.
    stale: r.stale !== false,
  };
}

/**
 * A connected machine's `GET /api/heavy-slot` body, validated field by field — it comes from
 * another host. Null when it isn't a snapshot at all (an older Shepherd answers 404 instead).
 */
export function parseHeavySlotSnapshot(raw: unknown): HeavySlotSnapshot | null {
  if (!rec(raw) || typeof raw.enabled !== "boolean" || !finite(raw.capacity)) return null;
  if (!Array.isArray(raw.holders) || !Array.isArray(raw.waiters)) return null;
  const brake = rec(raw.brake) ? raw.brake : {};
  const p = rec(raw.pressure) ? raw.pressure : {};
  const src = rec(raw.memoryBySource) ? raw.memoryBySource : {};
  return {
    enabled: raw.enabled,
    capacity: raw.capacity,
    holders: parseList(raw.holders, parseHolder),
    waiters: parseList(raw.waiters, parseWaiter),
    brake: { active: brake.active === true, reason: brake.reason === "memory" ? "memory" : null },
    pressure: {
      ramAvailableBytes: orNull(p.ramAvailableBytes),
      ramTotalBytes: orNull(p.ramTotalBytes),
      swapUsedBytes: orNull(p.swapUsedBytes),
      swapTotalBytes: orNull(p.swapTotalBytes),
      memFullAvg10: orNull(p.memFullAvg10),
      memBrakeThreshold: orNull(p.memBrakeThreshold),
      cpuSomeAvg10: orNull(p.cpuSomeAvg10),
    },
    memoryBySource: {
      agentsBytes: orNull(src.agentsBytes),
      foreignBytes: orNull(src.foreignBytes),
      foreignTop: parseList(src.foreignTop, parseForeign),
    },
    lastResults: parseList(raw.lastResults, parseLastResult),
  };
}

/** The ledger holder id of `shepherd slot run` calls made outside any session (#3550). */
export const OPERATOR_HOLDER = "operator";
