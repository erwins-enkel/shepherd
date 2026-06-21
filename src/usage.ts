import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { weightedUnits } from "./pricing";

/** Dashify a cwd into its ~/.claude/projects directory name: every `/` and `.` → `-`. */
export function dashify(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Absolute path to a session's JSONL given its worktree cwd + pinned claude session id. */
export function jsonlPathFor(worktreePath: string, claudeSessionId: string): string {
  return join(config.claudeProjectsDir, dashify(worktreePath), `${claudeSessionId}.jsonl`);
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

/** Accumulate one transcript's token buckets PLUS weighted cost (total, per-model, cacheRead-only),
 *  deduping by requestId. When sinceMs > 0, records with a known ts < sinceMs are skipped (live
 *  per-record windowing); sinceMs = 0 means whole-session. */
export function sessionCost(lines: Iterable<string>, sinceMs?: number): SessionCost {
  const usage = emptyUsage();
  // fullRecaches and sidechainCount are not tracked by this helper
  let totalWeightedUnits = 0;
  const weightedByModel: Record<string, number> = {};
  let cacheReadUnits = 0;
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
    usage.input += r.input;
    usage.output += r.output;
    usage.cacheRead += r.cacheRead;
    usage.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
    usage.messageCount += 1;
    if (r.ts) usage.lastActivity = Math.max(usage.lastActivity ?? 0, r.ts);
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
    usage.byModel[r.model] = (usage.byModel[r.model] ?? 0) + tokens;

    const wu = weightedUnits(r, r.model);
    totalWeightedUnits += wu;
    weightedByModel[r.model] = (weightedByModel[r.model] ?? 0) + wu;
    // isolate cacheRead-only units using the public weightedUnits (do not expose private weightsFor)
    cacheReadUnits += weightedUnits(
      { input: 0, output: 0, cacheRead: r.cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
      r.model,
    );
  }
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return { usage, weightedUnits: totalWeightedUnits, weightedByModel, cacheReadUnits };
}

/** The real model that produced the most tokens in this usage, or null when none was named.
 *  A reviewer session is effectively one model, so this resolves its TRUE model from the
 *  transcript — used to backfill the spawn row whose configured model was "auto" (null).
 *  Skips parseLine's "unknown" sentinel (an assistant record with no `model` field) so the
 *  sentinel can never overwrite a recorded model; "unknown"-only / empty usage → null. */
export function dominantModel(u: SessionUsage): string | null {
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, tokens] of Object.entries(u.byModel)) {
    if (model === "unknown") continue;
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = model;
    }
  }
  return best;
}

/** Read a session's JSONL transcript and accumulate its token totals. Returns null if the
 *  file is absent/unreadable (reviewer transcript not written, race, etc.). Async so the
 *  single server loop is never blocked by a sync read. */
export async function readSessionUsage(
  worktreePath: string,
  claudeSessionId: string,
): Promise<SessionUsage | null> {
  try {
    const text = await readFile(jsonlPathFor(worktreePath, claudeSessionId), "utf8");
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
