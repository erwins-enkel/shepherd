import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { timed } from "./instrument";
import { eachJsonlObject } from "./jsonl";

export interface ActivityEntry {
  ts: number; // ms epoch (tool_use message timestamp)
  tool: string; // raw tool name, e.g. "Edit"
  summary: string; // "edited server.ts"
  status: "ok" | "error" | "pending";
}

const DEFAULT_LIMIT = 30;
const CMD_MAX = 60;

function basename(p: unknown): string {
  if (typeof p !== "string" || !p) return "?";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function host(url: unknown): string {
  if (typeof url !== "string") return "?";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

type Summarizer = (input: Record<string, unknown>) => string;

/** Per-tool summary renderers; one shared renderer aliased across equivalent tools. */
const SUMMARIZERS: Record<string, Summarizer> = {
  Edit: (i) => `edited ${basename(i.file_path ?? i.notebook_path)}`,
  MultiEdit: (i) => `edited ${basename(i.file_path ?? i.notebook_path)}`,
  NotebookEdit: (i) => `edited ${basename(i.file_path ?? i.notebook_path)}`,
  Write: (i) => `wrote ${basename(i.file_path)}`,
  Read: (i) => `read ${basename(i.file_path)}`,
  Bash: (i) => `$ ${truncate(String(i.command ?? ""), CMD_MAX)}`,
  Grep: (i) => `searched "${i.pattern ?? ""}"`,
  Glob: (i) => `globbed ${i.pattern ?? ""}`,
  Task: (i) => `dispatched ${i.subagent_type ?? "agent"}`,
  Agent: (i) => `dispatched ${i.subagent_type ?? "agent"}`,
  Skill: (i) => `skill ${i.skill ?? ""}`,
  TodoWrite: () => "updated todos",
  TaskCreate: (i) => `added task: ${truncate(String(i.subject ?? ""), CMD_MAX)}`,
  TaskUpdate: (i) => {
    const id = i.taskId ?? "?";
    if (i.status === "in_progress") return `started task ${id}`;
    if (i.status === "completed") return `completed task ${id}`;
    if (i.status === "deleted") return `deleted task ${id}`;
    return `updated task ${id}`;
  },
  TaskList: () => "listed tasks",
  TaskGet: (i) => `read task ${i.taskId ?? "?"}`,
  WebFetch: (i) => `fetched ${host(i.url)}`,
  WebSearch: (i) => `web search "${i.query ?? ""}"`,
};

/** Render a tool_use block into a compact human summary line. */
function summarize(tool: string, input: Record<string, unknown>): string {
  const fn = SUMMARIZERS[tool];
  return fn ? fn(input) : tool.toLowerCase();
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

interface ParsedRecord {
  o: any;
  blocks: Block[];
}

/** Parse JSONL lines, keeping only records whose message content is a block array. */
function parseRecords(text: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const o of eachJsonlObject(text)) {
    const blocks = o?.message?.content;
    if (Array.isArray(blocks)) records.push({ o, blocks });
  }
  return records;
}

/** Map tool_use_id → is_error from every tool_result block (pass 1). */
function collectErrors(records: ParsedRecord[]): Map<string, boolean> {
  const errored = new Map<string, boolean>();
  for (const { blocks } of records) {
    for (const b of blocks) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        errored.set(b.tool_use_id, Boolean(b.is_error));
      }
    }
  }
  return errored;
}

/** Resolve a tool_use's status from the paired tool_result error map. */
function resolveStatus(errored: Map<string, boolean>, id: string): ActivityEntry["status"] {
  if (!errored.has(id)) return "pending";
  return errored.get(id) ? "error" : "ok";
}

/** Build ordered tool-use entries, attaching paired status (pass 2). */
function collectEntries(records: ParsedRecord[], errored: Map<string, boolean>): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const { o, blocks } of records) {
    const ts = Date.parse(o?.timestamp) || 0;
    for (const b of blocks) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const id = typeof b.id === "string" ? b.id : "";
      const status = resolveStatus(errored, id);
      entries.push({ ts, tool: b.name, summary: summarize(b.name, b.input ?? {}), status });
    }
  }
  return entries;
}

/**
 * 512 KB is far larger than the stall window's worth of JSONL records (a few
 * hundred bytes each × the last few hundred turns), so signal accuracy is fully
 * preserved while bounding the bytes fed to JSON.parse on every poll tick.
 */
export const MAX_TAIL_BYTES = 512 * 1024;

/**
 * Read only the last `maxBytes` bytes of a JSONL transcript file.
 *
 * When the file is larger than `maxBytes` the read starts mid-file; the leading
 * partial line (up to and including the first `\n`) is dropped so a truncated
 * record is never fed to the parser. When the whole file fits, the content is
 * returned intact. Throws on read errors (e.g. missing file) so callers can
 * handle with their existing try/catch → null patterns.
 */
export function readTranscriptTail(path: string, maxBytes = MAX_TAIL_BYTES): string {
  return timed(`transcript-tail ${basename(path)}`, () => {
    const fd = openSync(path, "r");
    try {
      const { size } = fstatSync(fd);
      const readBytes = Math.min(size, maxBytes);
      const buf = Buffer.allocUnsafe(readBytes);
      readSync(fd, buf, 0, readBytes, size - readBytes);
      const text = buf.toString("utf8");
      // started mid-file → drop the leading partial line
      if (size > maxBytes) {
        const nl = text.indexOf("\n");
        return nl === -1 ? "" : text.slice(nl + 1);
      }
      return text;
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * Parse a JSONL transcript into a chronological list of tool-use activity entries,
 * pairing each tool_use with its tool_result for status. Returns the most-recent
 * `limit` entries (oldest→newest). Malformed lines are skipped.
 */
export function parseActivity(text: string, limit = DEFAULT_LIMIT): ActivityEntry[] {
  const records = parseRecords(text);
  const errored = collectErrors(records);
  const entries = collectEntries(records, errored);
  return limit >= 0 ? entries.slice(-limit) : entries;
}

/**
 * Newest record timestamp across the whole transcript — assistant turns AND the
 * user records that carry tool_results. Unlike a tool_use entry's `ts` (the
 * tool's *start*), this advances on tool completions and resumed output, so it
 * reflects genuine forward progress. 0 when no record has a parseable timestamp.
 */
export function latestRecordTs(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = Date.parse(o?.timestamp) || 0;
    if (ts > max) max = ts;
  }
  return max;
}

/** Read + parse one session's JSONL. Missing/unreadable file → []. */
export async function sessionActivity(
  path: string,
  limit = DEFAULT_LIMIT,
): Promise<ActivityEntry[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return parseActivity(await file.text(), limit);
}
