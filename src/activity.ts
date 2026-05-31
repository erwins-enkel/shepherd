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

/** Render a tool_use block into a compact human summary line. */
function summarize(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `edited ${basename(input.file_path ?? input.notebook_path)}`;
    case "Write":
      return `wrote ${basename(input.file_path)}`;
    case "Read":
      return `read ${basename(input.file_path)}`;
    case "Bash":
      return `$ ${truncate(String(input.command ?? ""), CMD_MAX)}`;
    case "Grep":
      return `searched "${input.pattern ?? ""}"`;
    case "Glob":
      return `globbed ${input.pattern ?? ""}`;
    case "Task":
    case "Agent":
      return `dispatched ${input.subagent_type ?? "agent"}`;
    case "Skill":
      return `skill ${input.skill ?? ""}`;
    case "TodoWrite":
      return "updated todos";
    case "WebFetch":
      return `fetched ${host(input.url)}`;
    case "WebSearch":
      return `web search "${input.query ?? ""}"`;
    default:
      return tool.toLowerCase();
  }
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

/**
 * Parse a JSONL transcript into a chronological list of tool-use activity entries,
 * pairing each tool_use with its tool_result for status. Returns the most-recent
 * `limit` entries (oldest→newest). Malformed lines are skipped.
 */
export function parseActivity(text: string, limit = DEFAULT_LIMIT): ActivityEntry[] {
  const records: { o: any; blocks: Block[] }[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const blocks = o?.message?.content;
    if (Array.isArray(blocks)) records.push({ o, blocks });
  }

  // pass 1: map tool_use_id → is_error from every tool_result block
  const errored = new Map<string, boolean>();
  for (const { blocks } of records) {
    for (const b of blocks) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        errored.set(b.tool_use_id, Boolean(b.is_error));
      }
    }
  }

  // pass 2: collect tool_use blocks in order, attaching paired status
  const entries: ActivityEntry[] = [];
  for (const { o, blocks } of records) {
    const ts = Date.parse(o?.timestamp) || 0;
    for (const b of blocks) {
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const id = typeof b.id === "string" ? b.id : "";
      const status: ActivityEntry["status"] = !errored.has(id)
        ? "pending"
        : errored.get(id)
          ? "error"
          : "ok";
      entries.push({ ts, tool: b.name, summary: summarize(b.name, b.input ?? {}), status });
    }
  }

  return limit >= 0 ? entries.slice(-limit) : entries;
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
