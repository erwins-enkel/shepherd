import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { LimitWindow, UsageProviderSnapshot, UsageProviderSource } from "./usage-limits";

type CodexTokenSnapshot = Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }>;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
/** How many recent OpenAI rollouts to scan for the latest rate-limit event. The most recently
 *  touched session almost always carries it; a bounded fan-out covers fresh sessions that haven't
 *  logged one yet and stale DB rollout paths by also considering $CODEX_HOME/sessions. */
const ROLLOUT_SCAN_LIMIT = 24;
const ROLLOUT_TAIL_BYTES = 1_000_000;

interface CodexUsageRow {
  totalTokens: number | null;
  session5hTokens: number | null;
  weekTokens: number | null;
  updatedAt: number | null;
}

/** Tokens summary + recent rollout paths, read from one Codex state DB open. */
interface CodexState {
  totalTokens: number;
  session5hTokens: number;
  weekTokens: number;
  updatedAt: number;
  rolloutPaths: string[];
}

/** The 5h + weekly rate-limit windows parsed out of a Codex rollout log. */
export interface CodexRateLimits {
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  source: "rollout";
  checkedAt: number;
  filesScanned: number;
  latestEventAt: number | null;
}

export interface RolloutCandidate {
  path: string;
  mtimeMs: number;
  size: number;
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function rolloutCandidate(path: string): RolloutCandidate | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { path, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function dedupeRolloutCandidates(paths: string[], extra: RolloutCandidate[]): RolloutCandidate[] {
  const byPath = new Map<string, RolloutCandidate>();
  for (const path of paths) {
    const c = rolloutCandidate(path);
    if (c) byPath.set(c.path, c);
  }
  for (const c of extra) byPath.set(c.path, c);
  return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, ROLLOUT_SCAN_LIMIT);
}

/**
 * Every rollout file under `$CODEX_HOME/sessions`, newest-first by mtime, with NO count cap — the
 * complete set. Callers that only want the freshest few must slice themselves. `findCodexSessionId`
 * relies on the full list so a busy machine can't push a session's own rollout past a limit.
 */
export function listRolloutFiles(home = codexHome()): RolloutCandidate[] {
  const root = join(home, "sessions");
  const out: RolloutCandidate[] = [];
  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
      const c = rolloutCandidate(path);
      if (c) out.push(c);
    }
  }
  walk(root);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function recentCodexRolloutPaths(home = codexHome(), limit = ROLLOUT_SCAN_LIMIT): string[] {
  return listRolloutFiles(home)
    .slice(0, limit)
    .map((c) => c.path);
}

export function latestCodexStateDb(home = codexHome()): string | null {
  if (!existsSync(home)) return null;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return null;
  }
  const candidates = entries
    .map((name) => {
      const m = /^state_(\d+)\.sqlite$/.exec(name);
      return m ? { name, version: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; version: number } => x !== null)
    .sort((a, b) => b.version - a.version);
  return candidates[0] ? join(home, candidates[0].name) : null;
}

/** Read the token summary + recent rollout paths from a Codex state DB (single open). */
function readCodexState(dbPath: string, now: number): CodexState | null {
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query<CodexUsageRow, [number, number]>(
        `
        SELECT
          COALESCE(SUM(tokens_used), 0) AS totalTokens,
          COALESCE(SUM(CASE WHEN updated_at_ms >= ? THEN tokens_used ELSE 0 END), 0) AS session5hTokens,
          COALESCE(SUM(CASE WHEN updated_at_ms >= ? THEN tokens_used ELSE 0 END), 0) AS weekTokens,
          MAX(updated_at_ms) AS updatedAt
        FROM threads
        WHERE model_provider = 'openai'
      `,
      )
      .get(now - FIVE_HOURS_MS, now - WEEK_MS);
    if (!row || row.updatedAt === null) return null;
    // Defensive: older Codex schemas (and the unit-test fixtures) lack `rollout_path`. A failure
    // here must not sink the token reading, so the rollout query has its own guard.
    let rolloutPaths: string[] = [];
    try {
      rolloutPaths = db
        .query<{ rollout_path: string }, [number]>(
          `
          SELECT rollout_path FROM threads
          WHERE model_provider = 'openai' AND rollout_path <> ''
          ORDER BY updated_at_ms DESC LIMIT ?
        `,
        )
        .all(ROLLOUT_SCAN_LIMIT)
        .map((r) => r.rollout_path);
    } catch {
      rolloutPaths = [];
    }
    return {
      totalTokens: row.totalTokens ?? 0,
      session5hTokens: row.session5hTokens ?? 0,
      weekTokens: row.weekTokens ?? 0,
      updatedAt: row.updatedAt,
      rolloutPaths,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Build the base (rate-limit-free) Codex token snapshot. */
function tokenSnapshot(st: CodexState, now: number): CodexTokenSnapshot {
  return {
    provider: "codex",
    kind: "tokens",
    totalTokens: st.totalTokens,
    session5hTokens: st.session5hTokens,
    weekTokens: st.weekTokens,
    updatedAt: st.updatedAt,
    stale: now - st.updatedAt > STALE_MS,
    session5h: null,
    week: null,
  };
}

export function readCodexTokenUsage(dbPath: string, now: number): UsageProviderSnapshot | null {
  const st = readCodexState(dbPath, now);
  return st ? tokenSnapshot(st, now) : null;
}

/** Raw Codex token totals grouped by model for OpenAI threads updated in the selected range. */
export function readCodexModelUsage(
  dbPath: string | null,
  cutoff: number,
): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) return {};
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const columns = db.query(`PRAGMA table_info(threads)`).all() as { name: string }[];
    if (!columns.some((column) => column.name === "model")) {
      const row = db
        .query<{ tokens: number | null }, [number]>(
          `SELECT SUM(tokens_used) AS tokens
           FROM threads
           WHERE model_provider = 'openai' AND updated_at_ms >= ?`,
        )
        .get(cutoff);
      return row?.tokens ? { unknown: row.tokens } : {};
    }

    const rows = db
      .query<{ model: string; tokens: number }, [number]>(
        `SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model, SUM(tokens_used) AS tokens
         FROM threads
         WHERE model_provider = 'openai' AND updated_at_ms >= ?
         GROUP BY COALESCE(NULLIF(model, ''), 'unknown')`,
      )
      .all(cutoff);
    return Object.fromEntries(rows.filter((row) => row.tokens > 0).map((row) => [row.model, row.tokens]));
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

/** One rollout's `rate_limits.primary`/`.secondary` shape (Codex CLI session log). */
interface RolloutLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // epoch SECONDS
}

interface RolloutTokenCountEvent {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    rate_limits?: { primary?: RolloutLimitWindow; secondary?: RolloutLimitWindow } | null;
  };
}

function toLimitWindow(w: RolloutLimitWindow | null | undefined, now: number): LimitWindow | null {
  if (!w || typeof w.used_percent !== "number") return null;
  // resets_at is epoch seconds; fall back to now + window when absent so a bar still has a reset.
  const resetAt =
    typeof w.resets_at === "number"
      ? w.resets_at * 1000
      : now + (typeof w.window_minutes === "number" ? w.window_minutes * 60_000 : 0);
  return { pct: Math.max(0, Math.min(100, Math.round(w.used_percent))), resetAt };
}

type WindowBucket = "session5h" | "week";

const UNKNOWN_WINDOW_DURATIONS_WARNED = new Set<number>();

function bucketForWindow(
  w: RolloutLimitWindow,
  positionalFallback: WindowBucket,
): WindowBucket | null {
  if (typeof w.window_minutes !== "number") return positionalFallback;
  if (Math.abs(w.window_minutes - 300) <= 1) return "session5h";
  if (Math.abs(w.window_minutes - 10080) <= 1) return "week";
  if (!UNKNOWN_WINDOW_DURATIONS_WARNED.has(w.window_minutes)) {
    UNKNOWN_WINDOW_DURATIONS_WARNED.add(w.window_minutes);
    console.warn(`[codex-usage] ignoring unrecognized rate-limit window: ${w.window_minutes}m`);
  }
  return null;
}

function assignLimitWindow(
  out: { session5h: LimitWindow | null; week: LimitWindow | null },
  w: RolloutLimitWindow | null | undefined,
  positionalFallback: WindowBucket,
  now: number,
): void {
  if (!w) return;
  const bucket = bucketForWindow(w, positionalFallback);
  if (!bucket) return;
  const limit = toLimitWindow(w, now);
  if (!limit) return;
  out[bucket] = limit;
}

function readFileTail(path: string, maxBytes: number): string {
  const st = statSync(path);
  const start = Math.max(0, st.size - maxBytes);
  const length = st.size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

function parseRolloutLine(line: string): RolloutTokenCountEvent | null {
  if (!line || !line.includes('"rate_limits"')) return null;
  try {
    return JSON.parse(line) as RolloutTokenCountEvent;
  } catch {
    return null;
  }
}

function eventTimestampMs(timestamp: string | undefined): number | null {
  if (typeof timestamp !== "string") return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function rateLimitsFromEvent(obj: RolloutTokenCountEvent, now: number): CodexRateLimits | null {
  if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") return null;
  const rl = obj.payload.rate_limits;
  if (!rl) return null;
  const windows: { session5h: LimitWindow | null; week: LimitWindow | null } = {
    session5h: null,
    week: null,
  };
  assignLimitWindow(windows, rl.primary, "session5h", now);
  assignLimitWindow(windows, rl.secondary, "week", now);
  const { session5h, week } = windows;
  if (!session5h && !week) return null;
  return {
    session5h,
    week,
    source: "rollout",
    checkedAt: now,
    filesScanned: 0,
    latestEventAt: eventTimestampMs(obj.timestamp),
  };
}

/**
 * Extract the most recent rate-limit windows from one rollout JSONL file's content. Codex appends a
 * `{type:"event_msg", payload:{type:"token_count", rate_limits:{primary,secondary}}}` line on each
 * turn. Codex has emitted both positional primary=5h/secondary=weekly and duration-labelled
 * primary=weekly shapes; prefer `window_minutes` when present and fall back to position only for
 * older duration-less rollouts. The last such line is the current state.
 *
 * This is a line-based scan, which assumes the JSONL invariant of one complete JSON object per line
 * (Codex writes exactly that) — a pretty-printed, multi-line object would not parse. The pre-filter
 * matches only the `"rate_limits"` key (not `"rate_limits":{`) so whitespace after the colon is
 * tolerated; a `"rate_limits":null` line passes the filter but is dropped by the null check below.
 */
export function parseCodexRateLimits(content: string, now: number): CodexRateLimits | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = parseRolloutLine(lines[i] ?? "");
    if (!obj) continue;
    const rl = rateLimitsFromEvent(obj, now);
    if (rl) return rl;
  }
  return null;
}

/** Read the freshest rate-limit windows from the given rollout paths (newest first). */
export function readCodexRateLimits(paths: string[], now: number): CodexRateLimits | null {
  let filesScanned = 0;
  for (const path of paths) {
    let content: string;
    try {
      content = readFileTail(path, ROLLOUT_TAIL_BYTES);
      filesScanned++;
    } catch {
      continue;
    }
    const rl = parseCodexRateLimits(content, now);
    if (rl) return { ...rl, checkedAt: now, filesScanned };
  }
  return null;
}

export class CodexUsageProvider implements UsageProviderSource {
  constructor(
    private stateDbPath?: string,
    private home = codexHome(),
  ) {}

  // Rollout files reach several MB and `snapshot()` runs on every usage recompute (per request,
  // per poller tick). Cache the parsed rate limits keyed on candidate path + mtime + size so a
  // re-read only happens after Codex actually logs a new turn.
  private rlCache: { key: string; value: CodexRateLimits | null } | null = null;

  snapshot(now: number): UsageProviderSnapshot | null {
    const path = this.stateDbPath ?? latestCodexStateDb(this.home);
    if (!path) return null;
    const st = readCodexState(path, now);
    if (!st) return null;
    const base = tokenSnapshot(st, now);
    const fsCandidates = recentCodexRolloutPaths(this.home).flatMap((p) => {
      const c = rolloutCandidate(p);
      return c ? [c] : [];
    });
    const candidates = dedupeRolloutCandidates(st.rolloutPaths, fsCandidates);
    const rl = this.rateLimits(candidates, now);
    return {
      ...base,
      session5h: rl?.session5h ?? null,
      week: rl?.week ?? null,
      rateLimitSource: rl ? "rollout" : "missing",
      rateLimitCheckedAt: now,
      rateLimitFilesScanned: rl?.filesScanned ?? candidates.length,
      rateLimitLatestEventAt: rl?.latestEventAt ?? null,
    };
  }

  private rateLimits(candidates: RolloutCandidate[], now: number): CodexRateLimits | null {
    if (!candidates.length) return null;
    const key = candidates.map((c) => `${c.path}:${c.mtimeMs}:${c.size}`).join("|");
    if (this.rlCache?.key === key) return this.rlCache.value;
    const value = readCodexRateLimits(
      candidates.map((c) => c.path),
      now,
    );
    this.rlCache = { key, value };
    return value;
  }
}
