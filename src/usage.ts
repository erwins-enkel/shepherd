import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { weightedUnits } from "./pricing";

/** Dashify a cwd into its ~/.claude/projects directory name: every `/` and `.` → `-`. */
export function dashify(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** The claude projects dir a session's transcript lives under. When the agent was spawned
 *  into a swap/pool account (`spawnAccountDir` set — claude-swap sets CLAUDE_CONFIG_DIR to it),
 *  Claude Code writes the JSONL to `<account>/projects/…`, NOT the server's active projects
 *  dir. So resolution MUST follow the account, else every transcript readback (usage, activity,
 *  halt classification, MCP-auth URL) reads a nonexistent path and silently misses. Null/absent
 *  ⇒ the active `config.claudeProjectsDir` (session ran under the server's own account). */
function projectsDirFor(spawnAccountDir?: string | null): string {
  return spawnAccountDir ? join(spawnAccountDir, "projects") : config.claudeProjectsDir;
}

/** Absolute path to a session's JSONL given its worktree cwd + pinned claude session id, rooted
 *  under the session's spawn account when it was spawned into one (see `projectsDirFor`). */
export function jsonlPathFor(
  worktreePath: string,
  claudeSessionId: string,
  spawnAccountDir?: string | null,
): string {
  return join(projectsDirFor(spawnAccountDir), dashify(worktreePath), `${claudeSessionId}.jsonl`);
}

export interface ParsedRecord {
  ts: number; // ms epoch
  model: string;
  requestId: string | null;
  isSidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Parse one JSONL line into a usage record, or null if it carries no assistant usage. */
export function parseLine(line: string): ParsedRecord | null {
  const t = line.trim();
  if (!t) return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if ((o as { type?: unknown })?.type !== "assistant") return null;
  const rec = o as {
    type: string;
    timestamp?: unknown;
    requestId?: unknown;
    isSidechain?: unknown;
    message?: {
      role?: unknown;
      model?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      };
    };
  };
  const u = rec.message?.usage;
  if (!u) return null;
  const cc = u.cache_creation ?? {};
  return {
    ts: Date.parse(rec.timestamp as string) || 0,
    model: (rec.message?.model as string | undefined) ?? "unknown",
    requestId: (rec.requestId as string | null | undefined) ?? null,
    isSidechain: rec.isSidechain === true,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    // when the 5m/1h split is absent, attribute the legacy field to the 5m bucket
    cacheWrite5m: cc.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0,
    cacheWrite1h: cc.ephemeral_1h_input_tokens ?? 0,
  };
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  messageCount: number;
  lastActivity: number | null;
  byModel: Record<string, number>;
  /** Count of main-thread warm→cold prefix rebuilds: cacheRead dropped to 0 with a non-zero cache write, after a warm (cacheRead>0) main-thread record. Sidechain records are excluded. */
  fullRecaches: number;
  /** Count of accepted records whose isSidechain is true. */
  sidechainCount: number;
}

function emptyUsage(): SessionUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    messageCount: 0,
    lastActivity: null,
    byModel: {},
    fullRecaches: 0,
    sidechainCount: 0,
  };
}

/** Mutable cursor for the main-thread warm→cold recache edge detector. */
interface RecacheCursor {
  prevMainCacheRead: number;
}

/**
 * Update fullRecaches/sidechainCount for one ACCEPTED (post-dedupe) record.
 * Main-thread warm→cold drop (cacheRead 0 with a write, after a warm record) increments
 * fullRecaches; sidechain records only bump sidechainCount and never touch the cursor.
 */
function tallyRecache(out: SessionUsage, r: ParsedRecord, cursor: RecacheCursor): void {
  if (r.isSidechain) {
    out.sidechainCount += 1;
    return;
  }
  const cacheWrite = r.cacheWrite5m + r.cacheWrite1h;
  if (cursor.prevMainCacheRead > 0 && r.cacheRead === 0 && cacheWrite > 0) out.fullRecaches += 1;
  cursor.prevMainCacheRead = r.cacheRead;
}

/** Accumulate per-session token totals from JSONL lines, deduping by requestId. */
export function accumulate(lines: Iterable<string>): SessionUsage {
  const out = emptyUsage();
  const seen = new Set<string>();
  const cursor: RecacheCursor = { prevMainCacheRead: -1 };
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.requestId) {
      if (seen.has(r.requestId)) continue;
      seen.add(r.requestId);
    }
    out.input += r.input;
    out.output += r.output;
    out.cacheRead += r.cacheRead;
    out.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    out.messageCount += 1;
    if (r.ts) out.lastActivity = Math.max(out.lastActivity ?? 0, r.ts);
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    out.byModel[r.model] = (out.byModel[r.model] ?? 0) + tokens;
    tallyRecache(out, r, cursor);
  }
  out.total = out.input + out.output + out.cacheRead + out.cacheWrite;
  return out;
}

export interface SessionCost {
  usage: SessionUsage; // raw token buckets (input/output/cacheRead/cacheWrite/total/messageCount/byModel raw/lastActivity)
  weightedUnits: number; // total weighted units (per-record, honors 5m/1h split)
  weightedByModel: Record<string, number>; // weighted units per model id
  cacheReadUnits: number; // weighted units attributable to cacheRead tokens only
}

/** Accumulate one parsed record into the running session-cost accumulators. */
function accumulateCostRecord(
  r: ParsedRecord,
  usage: SessionUsage,
  cost: {
    totalWeightedUnits: number;
    weightedByModel: Record<string, number>;
    cacheReadUnits: number;
  },
): void {
  usage.input += r.input;
  usage.output += r.output;
  usage.cacheRead += r.cacheRead;
  usage.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
  usage.messageCount += 1;
  if (r.ts) usage.lastActivity = Math.max(usage.lastActivity ?? 0, r.ts);
  const tokens = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
  usage.byModel[r.model] = (usage.byModel[r.model] ?? 0) + tokens;

  const wu = weightedUnits(r, r.model);
  cost.totalWeightedUnits += wu;
  cost.weightedByModel[r.model] = (cost.weightedByModel[r.model] ?? 0) + wu;
  // isolate cacheRead-only units using the public weightedUnits (do not expose private weightsFor)
  cost.cacheReadUnits += weightedUnits(
    { input: 0, output: 0, cacheRead: r.cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
    r.model,
  );
}

/** Accumulate one transcript's token buckets PLUS weighted cost (total, per-model, cacheRead-only),
 *  deduping by requestId. When sinceMs > 0, records with a known ts < sinceMs are skipped (live
 *  per-record windowing); sinceMs = 0 means whole-session. */
export function sessionCost(lines: Iterable<string>, sinceMs?: number): SessionCost {
  const usage = emptyUsage();
  // fullRecaches and sidechainCount are not tracked by this helper
  const cost = {
    totalWeightedUnits: 0,
    weightedByModel: {} as Record<string, number>,
    cacheReadUnits: 0,
  };
  const seen = new Set<string>();

  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    // per-record time windowing: skip records with a known ts that is before sinceMs
    if (sinceMs && sinceMs > 0 && r.ts > 0 && r.ts < sinceMs) continue;
    if (r.requestId) {
      if (seen.has(r.requestId)) continue;
      seen.add(r.requestId);
    }
    accumulateCostRecord(r, usage, cost);
  }
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    usage,
    weightedUnits: cost.totalWeightedUnits,
    weightedByModel: cost.weightedByModel,
    cacheReadUnits: cost.cacheReadUnits,
  };
}

/** Pick the key with the maximum value from a byModel map, skipping the "unknown" sentinel.
 *  Returns null if the map is empty or contains only "unknown". */
export function dominantModelOf(byModel: Record<string, number>): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, tokens] of Object.entries(byModel)) {
    if (model === "unknown") continue;
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = model;
    }
  }
  return best;
}

/** The real model that produced the most tokens in this usage, or null when none was named.
 *  A reviewer session is effectively one model, so this resolves its TRUE model from the
 *  transcript — used to backfill the spawn row whose configured model was "auto" (null).
 *  Skips parseLine's "unknown" sentinel (an assistant record with no `model` field) so the
 *  sentinel can never overwrite a recorded model; "unknown"-only / empty usage → null. */
export function dominantModel(u: SessionUsage): string | null {
  return dominantModelOf(u.byModel);
}

/** Read a session's JSONL transcript and accumulate its token totals. Returns null if the
 *  file is absent/unreadable (reviewer transcript not written, race, etc.). Async so the
 *  single server loop is never blocked by a sync read. */
export async function readSessionUsage(
  worktreePath: string,
  claudeSessionId: string,
  spawnAccountDir?: string | null,
): Promise<SessionUsage | null> {
  try {
    const text = await readFile(
      jsonlPathFor(worktreePath, claudeSessionId, spawnAccountDir),
      "utf8",
    );
    return accumulate(text.split("\n"));
  } catch {
    return null;
  }
}

/** Read + accumulate one session's JSONL. Missing/unreadable file → zeroed usage. */
export async function sessionTokens(path: string): Promise<SessionUsage> {
  const file = Bun.file(path);
  if (!(await file.exists())) return emptyUsage();
  const text = await file.text();
  return accumulate(text.split("\n"));
}

// ── Account-wide incremental index ─────────────────────────────────────────────

interface FileState {
  size: number;
  offset: number;
  leftover: string;
  records: { ts: number; units: number }[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Indexes every JSONL under ~/.claude/projects, incrementally (only appended bytes are re-read).
 * Holds one weighted-unit record per assistant message, pruned to the last ~7 days.
 */
export class AccountUsageIndex {
  private files = new Map<string, FileState>();
  constructor(private projectsDir: string = config.claudeProjectsDir) {}

  /** Rescan the tree, ingesting newly-appended lines. Cheap to call repeatedly. */
  async refresh(now: number): Promise<void> {
    let paths: string[];
    try {
      paths = [...new Bun.Glob("*/*.jsonl").scanSync({ cwd: this.projectsDir, absolute: true })];
    } catch {
      return; // projects dir absent
    }
    const live = new Set(paths);
    for (const key of this.files.keys()) if (!live.has(key)) this.files.delete(key);

    const cutoff = now - WEEK_MS - 60_000;
    for (const path of paths) await this.ingestFile(path, cutoff);
  }

  /** Read appended bytes of one file into its FileState, then prune stale records. */
  private async ingestFile(path: string, cutoff: number): Promise<void> {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    let st = this.files.get(path);
    if (!st || size < st.offset) {
      st = { size, offset: 0, leftover: "", records: [] };
      this.files.set(path, st);
    }
    if (size > st.offset) await this.appendChunk(st, path, size);
    if (st.records.length && st.records[0]!.ts < cutoff) {
      st.records = st.records.filter((r) => r.ts >= cutoff);
    }
  }

  /** Read [offset, size) of a file and fold its complete lines into `st`. */
  private async appendChunk(st: FileState, path: string, size: number): Promise<void> {
    const chunk = await Bun.file(path).slice(st.offset, size).text();
    st.offset = size;
    st.size = size;
    const parts = (st.leftover + chunk).split("\n");
    st.leftover = parts.pop() ?? "";
    for (const line of parts) {
      const r = parseLine(line);
      if (!r || !r.ts) continue;
      st.records.push({ ts: r.ts, units: weightedUnits(r, r.model) });
    }
  }

  /** Sum weighted units across all files within [startMs, endMs]. */
  windowSum(startMs: number, endMs: number): number {
    let sum = 0;
    for (const st of this.files.values()) {
      for (const r of st.records) if (r.ts >= startMs && r.ts <= endMs) sum += r.units;
    }
    return sum;
  }
}

// ── Session bucket fold ───────────────────────────────────────────────────────

/** floor-hour: truncate ms-epoch to the start of its UTC hour. ts=0 → 0. */
export function floorHour(ts: number): number {
  return ts - (ts % 3_600_000);
}

export interface SessionBucket {
  bucketStart: number; // ms epoch, floorHour(ts); 0 = timeless
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number; // cacheWrite5m + cacheWrite1h
  weightedUnits: number;
  cacheReadUnits: number;
  byModel: Record<string, number>; // weighted units per model
  rawByModel: Record<string, number>; // raw tokens per model
}

export interface SessionFold {
  buckets: Map<number, SessionBucket>; // keyed by bucketStart
  rawByModel: Record<string, number>; // raw tokens per model, session-wide
  messageCount: number; // accepted (post-dedupe) record count
}

/** Single-pass fold of JSONL lines into per-hour buckets, deduping by requestId. */
export function foldSessionBuckets(lines: Iterable<string>): SessionFold {
  const buckets = new Map<number, SessionBucket>();
  const rawByModel: Record<string, number> = {};
  let messageCount = 0;
  const seen = new Set<string>();

  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.requestId) {
      if (seen.has(r.requestId)) continue;
      seen.add(r.requestId);
    }
    messageCount += 1;

    const bucketStart = floorHour(r.ts);
    let b = buckets.get(bucketStart);
    if (!b) {
      b = {
        bucketStart,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        weightedUnits: 0,
        cacheReadUnits: 0,
        byModel: {},
        rawByModel: {},
      };
      buckets.set(bucketStart, b);
    }

    b.input += r.input;
    b.output += r.output;
    b.cacheRead += r.cacheRead;
    b.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;

    const wu = weightedUnits(r, r.model);
    b.weightedUnits += wu;
    b.byModel[r.model] = (b.byModel[r.model] ?? 0) + wu;

    const cru = weightedUnits(
      { input: 0, output: 0, cacheRead: r.cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
      r.model,
    );
    b.cacheReadUnits += cru;

    const rawTokens = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    b.rawByModel[r.model] = (b.rawByModel[r.model] ?? 0) + rawTokens;
    rawByModel[r.model] = (rawByModel[r.model] ?? 0) + rawTokens;
  }

  return { buckets, rawByModel, messageCount };
}

// ── SessionUsageRollup ────────────────────────────────────────────────────────

export interface RollupWindow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  weightedUnits: number;
  cacheReadUnits: number;
  byModel: Record<string, number>; // weighted units per model (in-window)
  rawByModel: Record<string, number>; // raw tokens per model (in-window)
  dominantModel: string | null; // from in-window raw tokens (cutoff>0) or session-wide (cutoff===0)
  messageCount: number;
}

export interface RollupSession {
  id: string;
  worktreePath: string;
  claudeSessionId: string | null;
  /** Swap/pool account the agent ran under, so the rollup reads the JSONL where it was
   *  actually written (see `projectsDirFor`); null ⇒ the active projects dir. */
  spawnAccountDir?: string | null;
}

interface PerRecord {
  ts: number;
  requestId: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number; // 5m + 1h combined
  weighted: number; // weighted units
  cacheReadUnits: number;
  model: string;
  rawTokens: number; // for byModel raw tracking
}

interface AggTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  weightedUnits: number;
  cacheReadUnits: number;
  messageCount: number;
  weightedByModel: Record<string, number>; // weighted units per model
  rawByModel: Record<string, number>; // raw tokens per model
}

interface SessionFileState {
  size: number;
  offset: number;
  leftover: string;
  seen: Set<string>;
  records: PerRecord[];
  agg: AggTotals;
}

function emptyAgg(): AggTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    weightedUnits: 0,
    cacheReadUnits: 0,
    messageCount: 0,
    weightedByModel: {},
    rawByModel: {},
  };
}

const THIRTY_DAYS_MS = 30 * 86_400_000;
const PRUNE_SLACK_MS = 60_000;

/**
 * Per-session incremental rollup. Tracks session JSONL files, ingesting only appended bytes.
 * Maintains a per-record array (pruned to ~30d) plus an unpruned running aggregate.
 */
export class SessionUsageRollup {
  private sessions = new Map<string, SessionFileState>();
  private inflight: Promise<void> | null = null;

  /** Resolve the JSONL path for a session. Overridable for tests. */
  protected pathFor(
    worktreePath: string,
    claudeSessionId: string,
    spawnAccountDir?: string | null,
  ): string {
    return jsonlPathFor(worktreePath, claudeSessionId, spawnAccountDir);
  }

  /** Rescan sessions, ingesting newly-appended lines. Concurrent calls share one in-flight promise. */
  refresh(sessions: RollupSession[], now: number): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh(sessions, now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Prune records older than cutoff from st. ts=0 records are never pruned. */
  private pruneSession(st: SessionFileState, cutoff: number): void {
    // Walk every record — a ts=0 entry in slot 0 must not short-circuit the walk.
    let pruned = false;
    const kept: PerRecord[] = [];
    for (const rec of st.records) {
      if (rec.ts === 0 || rec.ts >= cutoff) {
        kept.push(rec);
      } else {
        if (rec.requestId) st.seen.delete(rec.requestId);
        pruned = true;
      }
    }
    if (pruned) st.records = kept;
  }

  /** Ingest one session file: stat, reset if truncated, appendChunk if grown, then prune. */
  private async ingestSession(sess: RollupSession, cutoff: number): Promise<void> {
    if (!sess.claudeSessionId) return;
    const path = this.pathFor(sess.worktreePath, sess.claudeSessionId, sess.spawnAccountDir);

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }

    let st = this.sessions.get(sess.id);
    if (!st || size < st.offset) {
      // File truncated/rotated — reset state
      st = { size, offset: 0, leftover: "", seen: new Set(), records: [], agg: emptyAgg() };
      this.sessions.set(sess.id, st);
    }

    if (size > st.offset) {
      await this.appendChunk(st, path, size);
    }

    this.pruneSession(st, cutoff);
  }

  private async doRefresh(sessions: RollupSession[], now: number): Promise<void> {
    // Drop sessions not in the new list
    const liveIds = new Set(sessions.map((s) => s.id));
    for (const key of this.sessions.keys()) {
      if (!liveIds.has(key)) this.sessions.delete(key);
    }

    const cutoff = now - THIRTY_DAYS_MS - PRUNE_SLACK_MS;

    for (const sess of sessions) {
      await this.ingestSession(sess, cutoff);
    }
  }

  private async appendChunk(st: SessionFileState, path: string, size: number): Promise<void> {
    const chunk = await Bun.file(path).slice(st.offset, size).text();
    st.offset = size;
    st.size = size;
    const parts = (st.leftover + chunk).split("\n");
    st.leftover = parts.pop() ?? "";
    for (const line of parts) {
      const r = parseLine(line);
      if (!r) continue;
      // Dedupe by requestId
      if (r.requestId) {
        if (st.seen.has(r.requestId)) continue;
        st.seen.add(r.requestId);
      }

      const wu = weightedUnits(r, r.model);
      const cru = weightedUnits(
        { input: 0, output: 0, cacheRead: r.cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
        r.model,
      );
      const cw = r.cacheWrite5m + r.cacheWrite1h;
      const rawTokens = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;

      const rec: PerRecord = {
        ts: r.ts,
        requestId: r.requestId,
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: cw,
        weighted: wu,
        cacheReadUnits: cru,
        model: r.model,
        rawTokens,
      };
      st.records.push(rec);

      // Update running aggregate (never pruned)
      const agg = st.agg;
      agg.input += r.input;
      agg.output += r.output;
      agg.cacheRead += r.cacheRead;
      agg.cacheWrite += cw;
      agg.weightedUnits += wu;
      agg.cacheReadUnits += cru;
      agg.messageCount += 1;
      agg.weightedByModel[r.model] = (agg.weightedByModel[r.model] ?? 0) + wu;
      agg.rawByModel[r.model] = (agg.rawByModel[r.model] ?? 0) + rawTokens;
    }
  }

  /**
   * Compute the RollupWindow for a session.
   * cutoff===0: return the unpruned running aggregate.
   * cutoff>0: sum per-record entries where ts===0 || ts>=cutoff.
   * Returns null if the session is unknown or the windowed messageCount===0.
   */
  windowedAccum(sessionId: string, cutoff: number): RollupWindow | null {
    const st = this.sessions.get(sessionId);
    if (!st) return null;

    if (cutoff === 0) {
      const agg = st.agg;
      if (agg.messageCount === 0) return null;
      return {
        input: agg.input,
        output: agg.output,
        cacheRead: agg.cacheRead,
        cacheWrite: agg.cacheWrite,
        weightedUnits: agg.weightedUnits,
        cacheReadUnits: agg.cacheReadUnits,
        byModel: { ...agg.weightedByModel },
        rawByModel: { ...agg.rawByModel },
        dominantModel: dominantModelOf(agg.rawByModel),
        messageCount: agg.messageCount,
      };
    }

    // cutoff > 0: sum in-window records
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheWrite = 0,
      wu = 0,
      cru = 0,
      messageCount = 0;
    const byModel: Record<string, number> = {};
    const rawByModel: Record<string, number> = {};

    // ts=0 ("timeless") records are always in-window; others are kept when ts >= cutoff.
    // This dedups at ingest and filters here, whereas sessionCost filters before its dedup.
    // The two only diverge for a duplicate requestId whose copies carry different ts — which
    // cannot happen for a real transcript (one requestId = one API response = one ts).
    for (const rec of st.records) {
      if (rec.ts !== 0 && rec.ts < cutoff) continue;
      input += rec.input;
      output += rec.output;
      cacheRead += rec.cacheRead;
      cacheWrite += rec.cacheWrite;
      wu += rec.weighted;
      cru += rec.cacheReadUnits;
      messageCount += 1;
      byModel[rec.model] = (byModel[rec.model] ?? 0) + rec.weighted;
      rawByModel[rec.model] = (rawByModel[rec.model] ?? 0) + rec.rawTokens;
    }

    if (messageCount === 0) return null;

    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      weightedUnits: wu,
      cacheReadUnits: cru,
      byModel,
      rawByModel,
      dominantModel: dominantModelOf(rawByModel),
      messageCount,
    };
  }

  /** Per-hour weighted units for one session's in-window records, keyed by floorHour(ts).
   *  Timeless records (ts=0) are excluded — they have no placeable hour, so they cannot sit on
   *  a timeline. cutoff===0 ⇒ every timestamped record; cutoff>0 ⇒ records with ts>=cutoff.
   *  Returns an empty map for an unknown session. Feeds buildUsageTimeline's live contribution. */
  hourlyUnits(sessionId: string, cutoff: number): Map<number, number> {
    const out = new Map<number, number>();
    const st = this.sessions.get(sessionId);
    if (!st) return out;
    for (const rec of st.records) {
      if (rec.ts === 0) continue; // timeless — not placeable on a timeline
      if (rec.ts < cutoff) continue; // out of window (cutoff===0 keeps all ts>0)
      const h = floorHour(rec.ts);
      out.set(h, (out.get(h) ?? 0) + rec.weighted);
    }
    return out;
  }
}
