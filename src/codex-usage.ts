import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { LimitWindow, UsageProviderSnapshot, UsageProviderSource } from "./usage-limits";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
/** How many recent OpenAI rollouts to scan for the latest rate-limit event. The most recently
 *  touched session almost always carries it; a small fan-out covers a freshly-started session
 *  whose first turn hasn't logged a rate-limit event yet (the limit is account-global, so an
 *  older session's last reading is still current). */
const ROLLOUT_SCAN_LIMIT = 8;

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
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
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
function tokenSnapshot(st: CodexState, now: number): UsageProviderSnapshot {
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

/** One rollout's `rate_limits.primary`/`.secondary` shape (Codex CLI session log). */
interface RolloutLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number; // epoch SECONDS
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

/**
 * Extract the most recent rate-limit windows from one rollout JSONL file's content. Codex appends a
 * `{type:"event_msg", payload:{type:"token_count", rate_limits:{primary,secondary}}}` line on each
 * turn; `primary` is the 5h window, `secondary` the weekly. The last such line is the current state.
 *
 * This is a line-based scan, which assumes the JSONL invariant of one complete JSON object per line
 * (Codex writes exactly that) — a pretty-printed, multi-line object would not parse. The pre-filter
 * matches only the `"rate_limits"` key (not `"rate_limits":{`) so whitespace after the colon is
 * tolerated; a `"rate_limits":null` line passes the filter but is dropped by the null check below.
 */
export function parseCodexRateLimits(content: string, now: number): CodexRateLimits | null {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap pre-filter: skip the vast majority of lines that carry no rate-limit reading at all.
    if (!line || !line.includes('"rate_limits"')) continue;
    let obj: {
      payload?: { rate_limits?: { primary?: RolloutLimitWindow; secondary?: RolloutLimitWindow } };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const rl = obj?.payload?.rate_limits;
    if (!rl) continue;
    const session5h = toLimitWindow(rl.primary, now);
    const week = toLimitWindow(rl.secondary, now);
    if (!session5h && !week) continue;
    return { session5h, week };
  }
  return null;
}

/** Read the freshest rate-limit windows from the given rollout paths (newest first). */
export function readCodexRateLimits(paths: string[], now: number): CodexRateLimits | null {
  for (const path of paths) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const rl = parseCodexRateLimits(content, now);
    if (rl) return rl;
  }
  return null;
}

export class CodexUsageProvider implements UsageProviderSource {
  constructor(private stateDbPath?: string) {}

  // Rollout files reach several MB and `snapshot()` runs on every usage recompute (per request,
  // per poller tick). Cache the parsed rate limits keyed on the freshest rollout's path + mtime so
  // a re-read only happens after Codex actually logs a new turn.
  private rlCache: { key: string; value: CodexRateLimits | null } | null = null;

  snapshot(now: number): UsageProviderSnapshot | null {
    const path = this.stateDbPath ?? latestCodexStateDb();
    if (!path) return null;
    const st = readCodexState(path, now);
    if (!st) return null;
    const base = tokenSnapshot(st, now);
    const rl = this.rateLimits(st.rolloutPaths, now);
    return { ...base, session5h: rl?.session5h ?? null, week: rl?.week ?? null };
  }

  private rateLimits(paths: string[], now: number): CodexRateLimits | null {
    if (!paths.length) return null;
    // Cache key is the freshest rollout's path + mtime only. Edge case: a rate-limit update that
    // lands in an OLDER rollout while the freshest one is untouched is served stale until the
    // freshest rollout's mtime changes. Tolerated on purpose — the rate limit is account-global, so
    // the most recently active session's rollout is the one that gets each turn's reading; any agent
    // actually consuming quota bumps the freshest mtime, evicting the cache within one turn.
    let key = paths[0]!;
    try {
      key = `${paths[0]}:${statSync(paths[0]!).mtimeMs}`;
    } catch {
      // stat failure ⇒ fall through to the bare path as the key and re-read
    }
    if (this.rlCache?.key === key) return this.rlCache.value;
    const value = readCodexRateLimits(paths, now);
    this.rlCache = { key, value };
    return value;
  }
}
