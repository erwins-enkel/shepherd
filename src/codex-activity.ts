import { eachJsonlObject } from "./jsonl";
import { readTranscriptTail, type ActivityEntry } from "./activity";
import { signalFrom, type SessionActivity } from "./activity-signal";
import { snapshotFrom, type ActivitySnapshot } from "./stall";
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

/** Render a Codex tool call into a compact summary line, mirroring `activity.ts`'s
 *  Bash renderer (`$ <cmd>`). Unknown shapes fall back to the tool name. */
function summarizeCodex(name: string, input: unknown): string {
  if (name === "exec") {
    const cmd = execCommand(input);
    if (cmd !== null) return `$ ${truncate(cmd, CMD_MAX)}`;
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
