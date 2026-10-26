import type { ChatEntry } from "./assistant-chat";
import type { ActivityEntry, BlockReason } from "./types";

/** One row of a session's Chat: a conversation row, or a run of tool calls between two of them. */
export type TimelineRow =
  | (ChatEntry & { key: string })
  | { kind: "tools"; calls: ActivityEntry[]; ts: number; key: string };

/**
 * The conversation rows and tool calls in transcript order; consecutive calls collapse into one
 * run. On an equal stamp the message goes first (a turn's text precedes its tool calls). A message
 * with no stamp keeps its place among the messages. Keys stay stable as rows are appended, so a
 * new row does not re-render (and re-parse) every row above it.
 */
export function chatTimeline(
  entries: readonly ChatEntry[],
  tools: readonly ActivityEntry[] = [],
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const seen: Record<string, number> = {};
  const keyOf = (base: string) => {
    const n = seen[base] ?? 0;
    seen[base] = n + 1;
    return `${base}:${n}`;
  };
  let t = 0;
  const pushTool = (call: ActivityEntry) => {
    const last = rows.at(-1);
    if (last?.kind === "tools") last.calls.push(call);
    else rows.push({ kind: "tools", calls: [call], ts: call.ts, key: keyOf(`tools:${call.ts}`) });
  };
  for (const e of entries) {
    while (e.ts > 0 && t < tools.length && tools[t].ts < e.ts) pushTool(tools[t++]);
    rows.push({ ...e, key: keyOf(`${e.kind}:${e.ts}`) });
  }
  while (t < tools.length) pushTool(tools[t++]);
  return rows;
}

const OPTION_LINE_RE = /^[\s│|]*[❯>*]?\s*\d+[.)]/;
const CONTEXT_LINES = 6;

/** The terminal lines a blocked prompt asks with: those above its option run (all of the tail
 *  when it has none, as with a (y/n) prompt), the last few. */
export function blockContext(tail: readonly string[]): string[] {
  const first = tail.findIndex((l) => OPTION_LINE_RE.test(l));
  return (first < 0 ? tail : tail.slice(0, first)).slice(-CONTEXT_LINES);
}

/** How the Chat answers a blocked prompt: buttons for a menu or a (y/n) prompt, a notice for an
 *  exhausted quota. Null for the rest: the composer answers an input prompt, and anything the
 *  Chat can't represent points to the Terminal. */
export type BlockCard = "menu" | "yes-no" | "quota";

export function blockCard(block: BlockReason | null): BlockCard | null {
  if (!block) return null;
  if (block.shape === "menu") return block.options.length > 0 ? "menu" : null;
  if (block.shape === "yes-no" || block.shape === "quota") return block.shape;
  return null;
}
