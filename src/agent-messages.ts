/**
 * An agent's last text messages, and whether its turn ended on a question (issue #2585).
 *
 * An orchestrator steering Shepherd sessions from the CLI saw only metadata (`status: done`) and
 * had to SSH into the server to read the transcript for the question the agent was waiting on.
 * This module reads the transcript tail — Claude's JSONL or Codex's rollout — and answers both.
 *
 * Detection is deterministic (no model): a session is awaiting input when it is at rest AND either
 * a Claude `AskUserQuestion` call is still unanswered, or the turn ended on agent text whose closing
 * paragraphs ask something ({@link looksLikeQuestion}). The transcript text is untrusted agent
 * output; it is only ever returned verbatim, never interpreted.
 */
import { readTranscriptTail } from "./activity";
import { eachJsonlObject } from "./jsonl";
import type { AgentProvider, SessionStatus } from "./types";

export interface AgentMessage {
  role: "assistant" | "user";
  text: string;
  /** ms epoch of the record; 0 when it carries no parseable timestamp. */
  ts: number;
}

/** Why no transcript could be read. `no-transcript`: nothing to resolve (no pinned agent session
 *  id, a Codex session whose native id isn't captured yet, or no rollout found). `file-missing`:
 *  resolved, but gone. */
export type MessagesUnavailable = "no-transcript" | "file-missing";

export interface SessionMessages {
  /** Oldest first. */
  messages: AgentMessage[];
  awaitingInput: boolean;
  pendingQuestion: string | null;
  unavailable: MessagesUnavailable | null;
}

export interface ParsedMessages {
  /** Every text message in the window, oldest first. */
  messages: AgentMessage[];
  /** The open question the transcript ends on, ignoring the session's status. */
  question: string | null;
}

/** Far more than the few turns this reads; bounds the parse on a multi-MB transcript. */
const TAIL_BYTES = 2 * 1024 * 1024;

/** How many trailing paragraphs may hold the question — enough for "Which one?" plus an option
 *  list and a closing line. */
const QUESTION_PARAGRAPHS = 3;

/** A `?` that ends a sentence: followed by whitespace, closing punctuation/markdown, or the end.
 *  A URL query (`?x=1`) is followed by a word char and does not match. */
const SENTENCE_QUESTION_RE = /\?(?=[\s*_`"'”“»)\]]|$)/;

/** Statuses at which the agent is waiting rather than working. */
const AT_REST: ReadonlySet<SessionStatus> = new Set(["idle", "done", "blocked"]);

export function looksLikeQuestion(text: string): boolean {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(-QUESTION_PARAGRAPHS)
    .some((p) => SENTENCE_QUESTION_RE.test(p));
}

function tsOf(o: { timestamp?: unknown }): number {
  return typeof o.timestamp === "string" ? Date.parse(o.timestamp) || 0 : 0;
}

// ── Claude JSONL ───────────────────────────────────────────────────────────────

interface ClaudeBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
}

interface ClaudeRecord {
  type?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  message?: { id?: unknown; content?: unknown };
}

/** The text of a user record: string content, or its `text` blocks. "" for tool_result-only. */
function userTextOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as ClaudeBlock[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** `question (A / B)` per question of an AskUserQuestion input, one per line. */
function askUserQuestionText(input: unknown): string {
  const questions = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(questions)) return "";
  return questions
    .map((q: { question?: unknown; options?: unknown }) => {
      const text = typeof q?.question === "string" ? q.question.trim() : "";
      const labels = Array.isArray(q?.options)
        ? q.options
            .map((o: { label?: unknown }) => (typeof o?.label === "string" ? o.label : ""))
            .filter(Boolean)
        : [];
      return labels.length ? `${text} (${labels.join(" / ")})` : text;
    })
    .filter(Boolean)
    .join("\n");
}

/** Mutable state of one Claude parse pass. */
interface ClaudeScan {
  messages: AgentMessage[];
  lastAssistantId: unknown;
  /** Did the last conversational record carry assistant text (vs. a tool call or user text)? */
  endsOnText: boolean;
  /** tool_use id → question text, for AskUserQuestion calls not yet answered. */
  pendingAsks: Map<string, string>;
}

function scanAssistant(scan: ClaudeScan, rec: ClaudeRecord, blocks: ClaudeBlock[]): void {
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      const text = b.text.trim();
      const last = scan.messages.at(-1);
      const id = rec.message?.id;
      if (last?.role === "assistant" && id !== undefined && id === scan.lastAssistantId)
        last.text = `${last.text}\n\n${text}`;
      else scan.messages.push({ role: "assistant", text, ts: tsOf(rec) });
      scan.lastAssistantId = id;
      scan.endsOnText = true;
    } else if (b?.type === "tool_use") {
      scan.endsOnText = false;
      if (b.name === "AskUserQuestion" && typeof b.id === "string")
        scan.pendingAsks.set(b.id, askUserQuestionText(b.input));
    }
  }
}

function scanUser(scan: ClaudeScan, rec: ClaudeRecord): void {
  const content = rec.message?.content;
  if (Array.isArray(content))
    for (const b of content as ClaudeBlock[])
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string")
        scan.pendingAsks.delete(b.tool_use_id);
  if (rec.isMeta === true) return;
  const text = userTextOf(content);
  if (!text) return;
  scan.messages.push({ role: "user", text, ts: tsOf(rec) });
  scan.lastAssistantId = undefined;
  scan.endsOnText = false;
}

export function parseClaudeMessages(text: string): ParsedMessages {
  const scan: ClaudeScan = {
    messages: [],
    lastAssistantId: undefined,
    endsOnText: false,
    pendingAsks: new Map(),
  };
  for (const o of eachJsonlObject(text)) {
    const rec = o as ClaudeRecord | null;
    if (!rec || rec.isSidechain === true) continue;
    if (rec.type === "assistant" && rec.isApiErrorMessage !== true) {
      const blocks = rec.message?.content;
      if (Array.isArray(blocks)) scanAssistant(scan, rec, blocks as ClaudeBlock[]);
    } else if (rec.type === "user") scanUser(scan, rec);
  }
  const asked = [...scan.pendingAsks.values()].filter(Boolean).at(-1);
  if (asked) return { messages: scan.messages, question: asked };
  const last = scan.messages.at(-1);
  const question =
    scan.endsOnText && last?.role === "assistant" && looksLikeQuestion(last.text)
      ? last.text
      : null;
  return { messages: scan.messages, question };
}

// ── Codex rollout ──────────────────────────────────────────────────────────────

interface CodexRecord {
  type?: unknown;
  timestamp?: unknown;
  payload?: { type?: unknown; role?: unknown; content?: unknown; message?: unknown };
}

function codexAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as ClaudeBlock[])
    .filter((b) => b?.type === "output_text" && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Turn-lifecycle events; the last one seen says whether the latest turn completed. */
const CODEX_TURN_EVENTS: ReadonlySet<unknown> = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
]);

/** Classify one rollout record as a text message, a turn-lifecycle event, or neither. */
function classifyCodexRecord(
  o: unknown,
): { message: AgentMessage } | { turnEvent: unknown } | null {
  const rec = o as CodexRecord | null;
  const p = rec?.payload;
  if (!rec || !p) return null;
  if (rec.type === "response_item" && p.type === "message" && p.role === "assistant") {
    const text = codexAssistantText(p.content);
    return text ? { message: { role: "assistant", text, ts: tsOf(rec) } } : null;
  }
  if (rec.type !== "event_msg") return null;
  if (p.type === "user_message") {
    const text = typeof p.message === "string" ? p.message.trim() : "";
    return text ? { message: { role: "user", text, ts: tsOf(rec) } } : null;
  }
  return CODEX_TURN_EVENTS.has(p.type) ? { turnEvent: p.type } : null;
}

export function parseCodexMessages(text: string): ParsedMessages {
  const messages: AgentMessage[] = [];
  let lastTurnEvent: unknown = null;
  for (const o of eachJsonlObject(text)) {
    const r = classifyCodexRecord(o);
    if (!r) continue;
    if ("message" in r) messages.push(r.message);
    else lastTurnEvent = r.turnEvent;
  }
  const last = messages.at(-1);
  const question =
    lastTurnEvent === "task_complete" && last?.role === "assistant" && looksLikeQuestion(last.text)
      ? last.text
      : null;
  return { messages, question };
}

// ── Per-session read ───────────────────────────────────────────────────────────

export interface MessagesQuery {
  /** How many messages to return (the newest); 0 returns only the flags. */
  limit: number;
  /** Keep the user's / steering messages alongside the agent's. */
  includeUser: boolean;
}

function unavailable(reason: MessagesUnavailable): SessionMessages {
  return { messages: [], awaitingInput: false, pendingQuestion: null, unavailable: reason };
}

/**
 * Read a session's transcript at `path` (resolved by the caller — the server owns the per-provider
 * path ladder) and answer its messages and open question. Never throws: an unreadable file reads
 * as `file-missing`.
 */
export async function sessionMessages(
  s: { status: SessionStatus; agentProvider?: AgentProvider | null },
  path: string | null,
  q: MessagesQuery,
): Promise<SessionMessages> {
  if (!path) return unavailable("no-transcript");
  let text: string;
  try {
    text = readTranscriptTail(path, TAIL_BYTES);
  } catch {
    return unavailable("file-missing");
  }
  const parsed =
    (s.agentProvider ?? "claude") === "codex"
      ? parseCodexMessages(text)
      : parseClaudeMessages(text);
  const question = AT_REST.has(s.status) ? parsed.question : null;
  const kept = q.includeUser
    ? parsed.messages
    : parsed.messages.filter((m) => m.role === "assistant");
  return {
    messages: q.limit > 0 ? kept.slice(-q.limit) : [],
    awaitingInput: question !== null,
    pendingQuestion: question,
    unavailable: null,
  };
}
