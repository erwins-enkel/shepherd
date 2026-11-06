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
import { parseActivityObjects, readTranscriptTailAsync, type ActivityEntry } from "./activity";
import { parseCodexActivityObjects } from "./codex-activity";
import { stripCodexLaunchMarker } from "./codex-session-id";
import { stripAssistantView } from "./operator-assistant-view";
import { stat } from "node:fs/promises";
import { eachJsonlObject } from "./jsonl";
import { transcriptSteer, type SteerKind } from "./steer-log";
import type { PendingAsk } from "./ask-user-question";
import type { AgentProvider, SessionStatus } from "./types";

export interface AgentMessage {
  role: "assistant" | "user";
  text: string;
  /** ms epoch of the record; 0 when it carries no parseable timestamp. */
  ts: number;
  /** On a user message Shepherd typed: which steer it is (src/steer-log.ts). Absent otherwise. */
  steer?: SteerKind;
  /** On the transcript's first message, when it is the operator's (the session's initial prompt)
   *  and the read window reached the file's start. Absent otherwise. */
  initial?: true;
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
  /** With `includeTools`: the tool calls in the same window, oldest first (the session Chat). */
  tools?: ActivityEntry[];
}

export interface ParsedMessages {
  /** Every text message in the window, oldest first. */
  messages: AgentMessage[];
  /** The open question the transcript ends on, ignoring the session's status. */
  question: string | null;
}

/** Far more than the few turns this reads; bounds the parse on a multi-MB transcript. */
const TAIL_BYTES = 2 * 1024 * 1024;

/** How far back {@link sessionMessages} reads to fill its limit when large records (base64
 *  screenshots in tool results) crowd the messages out of {@link TAIL_BYTES}. */
const MESSAGES_TAIL_MAX_BYTES = 16 * 1024 * 1024;

/** How many trailing paragraphs may hold the question — enough for "Which one?" plus an option
 *  list and a closing line. */
const QUESTION_PARAGRAPHS = 3;

/** A `?` that ends a sentence: followed by whitespace, closing punctuation/markdown, or the end.
 *  A URL query (`?x=1`) is followed by a word char and does not match. */
const SENTENCE_QUESTION_RE = /\?(?=[\s*_`"'”“»)\]]|$)/;

/** Statuses at which the agent is waiting rather than working. */
export const AT_REST: ReadonlySet<SessionStatus> = new Set(["idle", "done", "blocked"]);

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

/** The block `composeEpicSteer` (src/service.ts) appends to an operator reply, at the end of the
 *  text or before the closing tag of the paste Claude logs it in. */
const EPIC_NOTICE_RE =
  /\n\n<epic-authoring-notice>\n[\s\S]*?\n<\/epic-authoring-notice>(?=\n?(?:<\/pasted_content(?: id="[^"]*")?>\n?)?$)/;

/** A logged user turn without the epic-authoring notice Shepherd appended: what the operator
 *  typed, so the Chat matches the composer's text. The same tag inside the operator's words stays. */
export function stripEpicNotice(text: string): string {
  return text.replace(EPIC_NOTICE_RE, "");
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
  const text = stripEpicNotice(userTextOf(content));
  if (!text) return;
  scan.messages.push({ role: "user", text, ts: tsOf(rec) });
  scan.lastAssistantId = undefined;
  scan.endsOnText = false;
}

export function parseClaudeMessages(text: string): ParsedMessages {
  return parseClaudeMessageObjects(eachJsonlObject(text));
}

function parseClaudeMessageObjects(objs: Iterable<unknown>): ParsedMessages {
  const scan: ClaudeScan = {
    messages: [],
    lastAssistantId: undefined,
    endsOnText: false,
    pendingAsks: new Map(),
  };
  for (const o of objs) {
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
  payload?: {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    message?: unknown;
    item?: { type?: unknown; content?: unknown } | null;
  };
}

/** The `kind` text parts of a Codex content array (`output_text` for the agent, `text` in a
 *  UserMessage item); image parts are skipped. */
function codexContentText(content: unknown, kind: "output_text" | "text"): string {
  if (!Array.isArray(content)) return "";
  return (content as ClaudeBlock[])
    .filter((b) => b?.type === kind && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** How Codex delivers an answer given through Shepherd's question center (src/codex-question-state.ts). */
const QUESTION_REPLY_TAG = "<send_user_message_question_reply>";

/** A logged user turn as the operator's words: without the launch marker and ⟦VIEW⟧ block Shepherd
 *  sends ahead of them (#3709) or the epic notice after them, so the Chat matches the composer's
 *  text. No row for an empty turn or a native question's reply — like Claude's AskUserQuestion
 *  answer, a tool result. */
function codexUserMessage(raw: string, rec: CodexRecord): { message: AgentMessage } | null {
  const text = stripEpicNotice(stripAssistantView(stripCodexLaunchMarker(raw.trim()))).trim();
  if (!text || text.startsWith(QUESTION_REPLY_TAG)) return null;
  return { message: { role: "user", text, ts: tsOf(rec) } };
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
    const text = codexContentText(p.content, "output_text");
    return text ? { message: { role: "assistant", text, ts: tsOf(rec) } } : null;
  }
  if (rec.type !== "event_msg") return null;
  // The operator's turn: `user_message` up to Codex ~0.147, a completed UserMessage item since.
  // Never the `response_item` user messages, which also carry the harness's own context.
  if (p.type === "user_message")
    return codexUserMessage(typeof p.message === "string" ? p.message : "", rec);
  if (p.type === "item_completed" && p.item?.type === "UserMessage")
    return codexUserMessage(codexContentText(p.item.content, "text"), rec);
  return CODEX_TURN_EVENTS.has(p.type) ? { turnEvent: p.type } : null;
}

export function parseCodexMessages(text: string): ParsedMessages {
  return parseCodexMessageObjects(eachJsonlObject(text));
}

function parseCodexMessageObjects(objs: Iterable<unknown>): ParsedMessages {
  const messages: AgentMessage[] = [];
  let lastTurnEvent: unknown = null;
  for (const o of objs) {
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
  /** Also return the window's tool calls (`tools`). */
  includeTools?: boolean;
}

/** The newest tool calls `includeTools` returns. */
const TOOLS_MAX = 200;

const isCodex = (provider?: AgentProvider | null) => (provider ?? "claude") === "codex";

function parseTranscript(text: string, provider?: AgentProvider | null): ParsedMessages {
  return isCodex(provider) ? parseCodexMessages(text) : parseClaudeMessages(text);
}

/** The tool calls no older than the oldest kept message (all of them when no message was cut),
 *  newest {@link TOOLS_MAX}. */
function windowTools(
  objs: unknown[],
  provider: AgentProvider | null | undefined,
  oldest: number | null,
): ActivityEntry[] {
  const all = isCodex(provider)
    ? parseCodexActivityObjects(objs, -1)
    : parseActivityObjects(objs, -1);
  return (oldest === null ? all : all.filter((t) => t.ts >= oldest)).slice(-TOOLS_MAX);
}

/** Whether the session waits on a question — {@link sessionMessages}' `awaitingInput`, read off
 *  the event loop and without the messages. Never throws: an unreadable transcript reads false. */
export async function awaitingInput(
  s: { status: SessionStatus; agentProvider?: AgentProvider | null },
  path: string | null,
): Promise<boolean> {
  if (!path || !AT_REST.has(s.status)) return false;
  try {
    return (
      parseTranscript(await readTranscriptTailAsync(path, TAIL_BYTES), s.agentProvider).question !==
      null
    );
  } catch {
    return false;
  }
}

function withSteer(m: AgentMessage): AgentMessage {
  const steer = m.role === "user" ? transcriptSteer(m.text) : null;
  return steer ? { ...m, steer } : m;
}

function unavailable(reason: MessagesUnavailable): SessionMessages {
  return { messages: [], awaitingInput: false, pendingQuestion: null, unavailable: reason };
}

function keptMessages(parsed: ParsedMessages, q: MessagesQuery): AgentMessage[] {
  return q.includeUser ? parsed.messages : parsed.messages.filter((m) => m.role === "assistant");
}

/** The transcript tail parsed: {@link TAIL_BYTES}, doubled while it holds fewer than `q.limit`
 *  messages and more of the file is left, up to {@link MESSAGES_TAIL_MAX_BYTES}. Null when the
 *  file can't be read. */
async function readMessagesWindow(
  provider: AgentProvider | null | undefined,
  path: string,
  q: MessagesQuery,
): Promise<{ objs: unknown[]; parsed: ParsedMessages; whole: boolean } | null> {
  for (let bytes = TAIL_BYTES; ; bytes *= 2) {
    let text: string;
    let size: number;
    try {
      [text, { size }] = await Promise.all([readTranscriptTailAsync(path, bytes), stat(path)]);
    } catch {
      return null;
    }
    // One JSON pass serves both the messages and, with includeTools, the tool calls.
    const objs = [...eachJsonlObject(text)];
    const parsed = isCodex(provider)
      ? parseCodexMessageObjects(objs)
      : parseClaudeMessageObjects(objs);
    const full = keptMessages(parsed, q).length >= q.limit;
    const whole = size <= bytes;
    if (full || whole || bytes >= MESSAGES_TAIL_MAX_BYTES) return { objs, parsed, whole };
  }
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
  pendingAsks: PendingAsk[] = [],
): Promise<SessionMessages> {
  if (!path) return unavailable("no-transcript");
  const tail = await readMessagesWindow(s.agentProvider, path, q);
  if (!tail) return unavailable("file-missing");
  const { objs, parsed, whole } = tail;
  const structured = pendingAsks
    .flatMap((ask) => ask.questions.map((q) => q.question))
    .join("\n\n");
  const question = structured || (AT_REST.has(s.status) ? parsed.question : null);
  const kept = keptMessages(parsed, q);
  const messages = q.limit > 0 ? kept.slice(-q.limit).map(withSteer) : [];
  // The session's initial prompt: the transcript's first message, the operator's, still in view.
  const first = messages[0];
  if (whole && kept.length <= q.limit && first?.role === "user" && !first.steer)
    messages[0] = { ...first, initial: true };
  const result: SessionMessages = {
    messages,
    awaitingInput: question !== null,
    pendingQuestion: question,
    unavailable: null,
  };
  if (q.includeTools) {
    const oldest = messages.length < kept.length ? (messages[0]?.ts ?? Infinity) : null;
    result.tools = windowTools(objs, s.agentProvider, oldest);
  }
  return result;
}
