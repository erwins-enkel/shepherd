import { normalize } from "node:path";
import { eachJsonlObject } from "./jsonl";
import { readTranscriptTail, type ActivityEntry } from "./activity";
import { signalFrom, type SessionActivity } from "./activity-signal";
import { snapshotFrom, type ActivitySnapshot } from "./stall";
import { codexHome, listRolloutFiles } from "./codex-usage";
import { readSessionMeta } from "./codex-session-id";
import type { SessionUsage } from "./usage";

const CMD_MAX = 60;
const DEFAULT_LIMIT = 30;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Concatenate a `custom_tool_call_output.output` (array of `{text}` blocks, or a
 *  bare string) into one text blob for error/marker inspection. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

/**
 * Whether a tool output signals failure. Grounded in real rollouts (897/897
 * `custom_tool_call.status` values were "completed", so that field is useless):
 * the shell tool writes an `Exit code: <n>` line — nonzero ⇒ error. Default to
 * NOT an error: a missing red tint is cosmetic, a false one is a lie (issue #1816).
 */
function outputIsError(output: unknown): boolean {
  const m = /^Exit code:\s*(\d+)/m.exec(outputText(output));
  return m ? Number(m[1]) !== 0 : false;
}

/** Extract the shell command from an `exec` call's JS-snippet `input`
 *  (`... exec_command({cmd:"<cmd>", workdir:"..."}) ...`); null on any other shape
 *  so the caller can fall back to the tool name rather than throw. */
function execCommand(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = /cmd:\s*("(?:[^"\\]|\\.)*")/.exec(input);
  if (!m || m[1] === undefined) return null;
  try {
    const cmd = JSON.parse(m[1]) as unknown;
    return typeof cmd === "string" ? cmd : null;
  } catch {
    return null;
  }
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** Extract the first file path from an apply_patch envelope
 *  (`*** Add|Update|Delete File: <path>`), which a real reviewer's `exec` call
 *  builds as a JS string instead of an `exec_command`. null on any other shape. */
function patchFile(input: unknown): string | null {
  if (typeof input !== "string" || !input.includes("*** Begin Patch")) return null;
  // Stop at whitespace OR backslash: the path is followed by an escaped newline
  // (`\n`, two literal chars) in the un-unescaped JS-string envelope.
  const m = /\*\*\* (?:Add|Update|Delete) File:\s*([^\s\\]+)/.exec(input);
  return m && m[1] !== undefined ? m[1] : null;
}

/** Render a Codex tool call into a compact summary line, mirroring `activity.ts`'s
 *  Bash renderer (`$ <cmd>`). All shell + patch work arrives as an `exec` call; a
 *  shape we don't recognize falls back to the tool name (never throws, never empty). */
function summarizeCodex(name: string, input: unknown): string {
  if (name === "exec") {
    const cmd = execCommand(input);
    if (cmd !== null) return `$ ${truncate(cmd, CMD_MAX)}`;
    const file = patchFile(input);
    if (file !== null) return `patch ${basename(file)}`;
  }
  return name.toLowerCase();
}

interface OutputInfo {
  error: boolean;
}

/**
 * Parse a Codex rollout JSONL into chronological `ActivityEntry[]` (the same shape
 * `src/activity.ts` produces for Claude), pairing each `custom_tool_call` with its
 * `custom_tool_call_output` via `call_id` for status:
 *   - no matching output      → "pending"  (this is what stall detection reads)
 *   - output with nonzero exit → "error"
 *   - otherwise               → "ok"
 * Returns the most-recent `limit` entries (oldest→newest); `-1` = all. Malformed
 * lines are skipped; never throws.
 */
export function parseCodexActivity(text: string, limit = DEFAULT_LIMIT): ActivityEntry[] {
  const outputs = new Map<string, OutputInfo>();
  const calls: Array<{ ts: number; name: string; input: unknown; callId: string }> = [];

  for (const o of eachJsonlObject(text)) {
    const rec = o as { type?: unknown; timestamp?: unknown; payload?: unknown };
    if (rec.type !== "response_item") continue;
    const p = rec.payload as
      | { type?: unknown; call_id?: unknown; name?: unknown; input?: unknown; output?: unknown }
      | undefined;
    if (!p) continue;
    if (p.type === "custom_tool_call" && typeof p.name === "string") {
      const ts = Date.parse((rec.timestamp as string) ?? "") || 0;
      calls.push({
        ts,
        name: p.name,
        input: p.input,
        callId: typeof p.call_id === "string" ? p.call_id : "",
      });
    } else if (p.type === "custom_tool_call_output" && typeof p.call_id === "string") {
      outputs.set(p.call_id, { error: outputIsError(p.output) });
    }
  }

  const entries: ActivityEntry[] = calls.map((c) => {
    const out = c.callId ? outputs.get(c.callId) : undefined;
    const status: ActivityEntry["status"] = !out ? "pending" : out.error ? "error" : "ok";
    return { ts: c.ts, tool: c.name, summary: summarizeCodex(c.name, c.input), status };
  });

  return limit >= 0 ? entries.slice(-limit) : entries;
}

/**
 * Newest record timestamp across the whole rollout — the heartbeat. Every Codex
 * rollout record (session_meta, response_item, event_msg) carries a top-level
 * `timestamp`. Peer of `latestRecordTs` in `src/activity.ts`. 0 when none parse.
 */
export function latestCodexRecordTs(text: string): number {
  let max = 0;
  for (const o of eachJsonlObject(text)) {
    const ts = Date.parse((o as { timestamp?: unknown }).timestamp as string) || 0;
    if (ts > max) max = ts;
  }
  return max;
}

/** Pure: derive both signals from already-read rollout text (one parse). */
export function codexSignalsFromText(text: string): {
  snapshot: ActivitySnapshot | null;
  activity: SessionActivity | null;
} {
  const entries = parseCodexActivity(text);
  const lastTs = latestCodexRecordTs(text);
  return { snapshot: snapshotFrom(entries, lastTs), activity: signalFrom(entries, lastTs) };
}

/**
 * Read a Codex rollout JSONL and derive BOTH the stall snapshot and the activity
 * signal from a SINGLE tail-read + parse — the Codex peer of
 * `readTranscriptSignals` (`src/activity-signal.ts`). Missing/unreadable file →
 * both null. Feeding `snapshotFrom` AND `signalFrom` from one parse means summary,
 * heat-strip, error tint and stall all hang on the same pipeline as Claude.
 */
export function readCodexTranscriptSignals(path: string): {
  snapshot: ActivitySnapshot | null;
  activity: SessionActivity | null;
} {
  let text: string;
  try {
    text = readTranscriptTail(path);
  } catch {
    return { snapshot: null, activity: null };
  }
  return codexSignalsFromText(text);
}

/**
 * Codex rollout readback — the provider-native counterpart to the claude-only
 * transcript layer (`src/activity.ts` + `src/usage.ts`). Codex writes
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, NOT `~/.claude/projects/**.jsonl`,
 * so the claude readers return null for every Codex role spawn (issue #1816). This
 * module parses that rollout format into the same `ActivityEntry` / `SessionUsage`
 * shapes the rest of Shepherd already consumes.
 */

/** One `token_count` event's cumulative usage snapshot. */
interface TotalTokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse a Codex rollout JSONL into a `SessionUsage`, mirroring Claude's disjoint
 * buckets (`usage.ts`: total = input + output + cacheRead + cacheWrite).
 *
 * Two traps this deliberately avoids (both measured on real rollouts):
 *  - `total_token_usage` is CUMULATIVE across the session — the values grow every
 *    turn. Summing the events would ~6× overcount. Only the LAST event counts.
 *  - `cached_input_tokens` is a SUBSET of `input_tokens` (and
 *    `reasoning_output_tokens` a subset of `output_tokens`). So `input` must
 *    exclude the cached portion, and reasoning is never added on top.
 *
 * `modelHint` is supplied by the caller (the `token_count` record carries no
 * model); absent → the usage is attributed to "unknown".
 */
export function parseCodexUsage(text: string, modelHint?: string | null): SessionUsage {
  let last: TotalTokenUsage | null = null;
  let lastTs: number | null = null;
  let count = 0;
  for (const o of eachJsonlObject(text)) {
    const rec = o as { type?: unknown; timestamp?: unknown; payload?: unknown };
    if (rec.type !== "event_msg") continue;
    const p = rec.payload as { type?: unknown; info?: unknown } | undefined;
    if (p?.type !== "token_count") continue;
    const info = p.info as { total_token_usage?: TotalTokenUsage } | undefined;
    if (!info?.total_token_usage) continue;
    count += 1;
    last = info.total_token_usage;
    const ts = Date.parse((rec.timestamp as string) ?? "");
    if (Number.isFinite(ts)) lastTs = ts;
  }

  const cacheRead = last ? num(last.cached_input_tokens) : 0;
  const input = last ? Math.max(0, num(last.input_tokens) - cacheRead) : 0;
  const output = last ? num(last.output_tokens) : 0;
  const cacheWrite = 0; // OpenAI caching is automatic — no write premium (#1160)
  const total = input + output + cacheRead + cacheWrite;
  const model = modelHint || "unknown";

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    messageCount: count,
    lastActivity: lastTs,
    byModel: total > 0 ? { [model]: total } : {},
    fullRecaches: 0,
    sidechainCount: 0,
  };
}

// ── Rollout resolution ──────────────────────────────────────────────────────
//
// Correlating a reviewer spawn to its Codex rollout rests on ONE invariant (A0,
// issue #1816): the reviewer's disposable-worktree cwd is unique per spawn,
// because the spawn passes its trackingId as the createDetached slug (exactly as
// plan-gate already does). So the rollout whose session_meta.cwd equals the
// worktree path is THE one — decided at launch, not guessed from timestamps.
//
// This deliberately does NOT use a time window, "lowest ts wins", or a counting
// heuristic: rollout WRITE order is not launch order (a slow Codex start can write
// its session_meta after a sibling's launch), so any select-from-candidates rule
// over cwd+time can grab a sibling's rollout — and the mistake is permanent once
// persisted. A wrong resolution is worse than none, so the rule is fail-safe: a
// unique cwd match, else null.

/** One rollout's identity, as read from its `session_meta` header. `rolloutId` is
 *  the Codex-native session id; metas whose header lacks an id are dropped upstream. */
export interface RolloutMeta {
  path: string;
  cwd: string;
  rolloutId: string;
  source: string;
  mtimeMs: number;
}

export interface SelectRolloutOpts {
  worktreePath: string;
  source: "exec" | "cli";
  /** When known, resolves exactly by native id — immune to any cwd ambiguity. */
  providerSessionId?: string | null;
}

/** The candidates for a spawn: an exact id match when `providerSessionId` is
 *  known, else every rollout of the right `source` whose cwd equals the worktree. */
function candidatesFor(metas: RolloutMeta[], opts: SelectRolloutOpts): RolloutMeta[] {
  if (opts.providerSessionId) {
    return metas.filter((m) => m.rolloutId === opts.providerSessionId);
  }
  const target = normalize(opts.worktreePath);
  return metas.filter((m) => m.source === opts.source && normalize(m.cwd) === target);
}

/** Pure ownership selection. Resolves ONLY on a unique candidate; 0 or ≥2 → null
 *  (≥2 is an A0-invariant violation, possible only for pre-A0 SHA-named cwds). */
export function selectCodexRollout(
  metas: RolloutMeta[],
  opts: SelectRolloutOpts,
): { path: string; rolloutId: string } | null {
  const c = candidatesFor(metas, opts);
  return c.length === 1 ? { path: c[0]!.path, rolloutId: c[0]!.rolloutId } : null;
}

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface ResolverDeps {
  /** Lists rollout metas (the tree walk over `$CODEX_HOME/sessions`). Injected. */
  listMetas: () => RolloutMeta[];
  now: () => number;
  warn?: (msg: string) => void;
}

export interface ResolveArgs {
  trackingId: string;
  worktreePath: string;
  source: "exec" | "cli";
  providerSessionId?: string | null;
}

/**
 * Per-service resolver that wraps `selectCodexRollout` with a positive cache and a
 * miss backoff, both keyed by `trackingId`. NOT reusable from the poller's private
 * `codexCaptureBackoff` (that is task-session-keyed, reset on seed/prune). One
 * instance per service; pure process state — the persisted `reviewer_spawns`
 * column is the restart-durable truth.
 */
export class CodexRolloutResolver {
  private cache = new Map<string, { path: string; rolloutId: string }>();
  private backoff = new Map<string, { nextAt: number; misses: number }>();

  constructor(private deps: ResolverDeps) {}

  /**
   * Resolve a spawn's rollout. Returns a proven hit (cached thereafter), or null
   * on a miss (a widening backoff bounds the tree walk). Never caches a null.
   * `bypassBackoff` forces one walk regardless of the backoff clock — for finalize's
   * last-chance attempt before the in-flight record disappears.
   */
  resolve(
    args: ResolveArgs,
    opts?: { bypassBackoff?: boolean },
  ): { path: string; rolloutId: string } | null {
    const cached = this.cache.get(args.trackingId);
    if (cached) return cached;

    const bo = this.backoff.get(args.trackingId);
    if (!opts?.bypassBackoff && bo && this.deps.now() < bo.nextAt) return null;

    const metas = this.deps.listMetas();
    const candidates = candidatesFor(metas, args);
    if (candidates.length === 1) {
      const hit = { path: candidates[0]!.path, rolloutId: candidates[0]!.rolloutId };
      this.cache.set(args.trackingId, hit);
      this.backoff.delete(args.trackingId);
      return hit;
    }
    if (candidates.length >= 2) {
      this.deps.warn?.(
        `codex rollout ambiguity for ${args.trackingId}: ${candidates.length} exec rollouts share cwd ${args.worktreePath} (pre-A0 SHA-named worktree?) — leaving unresolved`,
      );
    }
    const misses = (bo?.misses ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (misses - 1), BACKOFF_CAP_MS);
    this.backoff.set(args.trackingId, { nextAt: this.deps.now() + delay, misses });
    return null;
  }

  /** Drop a spawn's cache + backoff (on proven resolution's downstream persist, and
   *  on finalize/completedAt so the maps can't grow unbounded). */
  reset(trackingId: string): void {
    this.cache.delete(trackingId);
    this.backoff.delete(trackingId);
  }
}

/**
 * Production rollout lister: every rollout under `$CODEX_HOME/sessions` with a
 * parseable `session_meta` header carrying an id, as `RolloutMeta[]`. This is the
 * tree walk (currently ~1600 files); the `CodexRolloutResolver` bounds how often it
 * runs (once per reviewer miss, then cache + backoff). Reuses `listRolloutFiles`
 * (stat-only, newest-first) and the shared `readSessionMeta` header parser.
 */
export function listRolloutMetas(home = codexHome()): RolloutMeta[] {
  const out: RolloutMeta[] = [];
  for (const { path, mtimeMs } of listRolloutFiles(home)) {
    const meta = readSessionMeta(path);
    if (!meta || !meta.id || !meta.source) continue;
    out.push({ path, cwd: meta.cwd, rolloutId: meta.id, source: meta.source, mtimeMs });
  }
  return out;
}

/** Build a resolver wired to the real filesystem + a warning logger. One per service. */
export function createCodexRolloutResolver(home = codexHome()): CodexRolloutResolver {
  return new CodexRolloutResolver({
    listMetas: () => listRolloutMetas(home),
    now: () => Date.now(),
    warn: (m) => console.warn(`[codex-activity] ${m}`),
  });
}
