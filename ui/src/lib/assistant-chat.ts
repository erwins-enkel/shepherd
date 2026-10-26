import type { AssistantViewReport, ViewTab } from "./operator-assistant-view";
import type { AgentMessage, Session } from "./types";

/** One row of the Operator Assistant's conversation view. */
export type ChatEntry =
  | { kind: "assistant"; text: string; ts: number }
  | { kind: "user"; text: string; ts: number }
  /** Harness traffic logged as user input (a background task's notice): not the operator's words. */
  | { kind: "event"; text: string; ts: number };

/** Tags Claude Code wraps its own user-role records in. Operator text starting with any other
 *  `<tag>` is the operator's and stays a message. */
const HARNESS_TAGS = new Set([
  "task-notification",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "system-reminder",
  "user-prompt-submit-hook",
]);

const LEADING_TAG_RE = /^<([a-z][a-z0-9-]*)>/;

function tagText(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : null;
}

/**
 * The transcript's text messages as conversation rows. Claude Code logs harness traffic as user
 * records too: a background task's `<task-notification>` becomes a quiet event row (its summary),
 * a slash command the `/name args` line the operator typed, and any other harness record (command
 * output, caveats) is dropped — the Terminal view still shows all of it verbatim.
 */
export function chatEntries(messages: AgentMessage[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const { role, text, ts } of messages) {
    const tag = role === "user" ? LEADING_TAG_RE.exec(text)?.[1] : undefined;
    if (!tag || !HARNESS_TAGS.has(tag)) {
      out.push({ kind: role, text, ts });
      continue;
    }
    const command = tagText(text, "command-name");
    if (command) {
      const args = tagText(text, "command-args");
      out.push({ kind: "user", text: args ? `${command} ${args}` : command, ts });
    } else if (tag === "task-notification") {
      const summary = tagText(text, "summary");
      if (summary) out.push({ kind: "event", text: summary, ts });
    }
  }
  return out;
}

/** The composer's message: the typed words, then one line per attached image for the assistant to
 *  Read. Each path sits in backticks: Claude Code turns a pasted segment ending in an image
 *  extension into an [Image #N] chip asynchronously and drops the Enter sent with the paste. */
export function assistantChatMessage(typed: string, paths: readonly string[]): string {
  const images = paths.map((p) => `Attached image: \`${p}\``).join("\n");
  return [typed, images].filter(Boolean).join("\n\n");
}

/** A message the operator sent from the composer, shown until the transcript logs it. */
export interface PendingSend {
  text: string;
  /** ms epoch (browser clock) of the send. */
  at: number;
  /** Set when images rode along: Claude may rewrite their pasted paths, so the echo only has to
   *  contain these typed words (any user row when empty), not equal `text`. */
  match?: string;
}

/** Browser and server clocks may disagree; a logged echo may carry a slightly earlier stamp. */
const ECHO_SKEW_MS = 60_000;

/** The sends the transcript has not logged yet: no user row with the same text, stamped no
 *  earlier than the skew window before the send (an older identical message is not the echo).
 *  Each row settles one send, so a repeated answer ("Yes", then "Yes") waits for its own echo. */
export function unsettled(pending: PendingSend[], entries: ChatEntry[]): PendingSend[] {
  const used = new Set<number>();
  return pending.filter((p) => {
    const i = entries.findIndex(
      (e, j) =>
        !used.has(j) &&
        e.kind === "user" &&
        (p.match === undefined
          ? e.text.trim() === p.text.trim()
          : e.text.includes(p.match.trim())) &&
        e.ts >= p.at - ECHO_SKEW_MS,
    );
    if (i < 0) return true;
    used.add(i);
    return false;
  });
}

/** What the assistant sees of the operator's window, for the panel's context line. Null when no
 *  session is in view, or the report names one the herd no longer lists. */
export function viewFocus(
  report: AssistantViewReport | null,
  herd: Pick<Session, "id" | "desig">[],
): { desig: string; tab: ViewTab | null; host: string | null } | null {
  const focus = report?.focus;
  if (!focus || focus.kind === "none") return null;
  if (focus.kind === "remote") return { desig: focus.desig, tab: null, host: focus.host };
  const s = herd.find((h) => h.id === focus.id);
  return s ? { desig: s.desig, tab: focus.tab, host: null } : null;
}

type YesNoQuestion = { number: string | null; text: string };

/** Explicit yes/no questions at the end of a reply, never examples in quotes or code. */
export function yesNoQuestions(text: string): YesNoQuestion[] {
  let fence: string | null = null;
  let quoted = false;
  const lines = text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return null;
      }
      if (!line.trim()) quoted = false;
      if (/^\s*>/.test(line)) quoted = true;
      if (fence || quoted || /^(?: {4}|\t)/.test(line)) return null;
      return line.trim().replace(/^[*_]+|[*_]+$/g, "");
    });
  const candidates = trailingQuestionLines(lines);
  const questions = [];
  for (const line of candidates) {
    if (line === "") continue;
    if (!line) return [];
    const question = parseYesNoQuestion(line);
    if (!question) return [];
    questions.push(question);
  }
  return questions;
}

/** Only the trailing list belongs to the answer; earlier status lists are context. */
function trailingQuestionLines(lines: (string | null)[]): (string | null)[] {
  const numberedLine = /^\d+[.)]\s/;
  let start = lines.length - 1;
  const numbered = numberedLine.test(lines[start] ?? "");
  for (let i = start - 1; numbered && i >= 0; i--) {
    if (lines[i] === "") {
      const previous = lines.slice(0, i).findLastIndex((line) => line !== "");
      // Blank lines join question items, but separate a preceding status list.
      if (!/^\d+[.)]\s.*\?/.test(lines[previous] ?? "")) break;
      i = previous;
    }
    const line = lines[i];
    if (!line || !numberedLine.test(line)) break;
    start = i;
  }
  const prefix = lines.slice(0, start);
  const boundary = prefix.findLastIndex((line) => !line);
  // A wrapped item in the same paragraph must not become a partial answer.
  if (prefix.slice(boundary + 1).some((line) => line !== null && numberedLine.test(line)))
    return [];
  return lines.slice(start);
}

/** Validate one explicit question after its Markdown context has been checked. */
function parseYesNoQuestion(line: string): YesNoQuestion | null {
  const match = /^(\d+)[.)]\s+(.+)$/.exec(line);
  const question = (match ? match[2] : line).replace(/^[*_]+|[*_]+$/g, "");
  const plain = question.replace(/[*_]/g, "");
  const marker = /\s*\(\s*(?:ja\s*\/\s*nein|yes\s*\/\s*no)\s*\)\s*(\?)?$/i.exec(plain);
  if (!marker) return null;
  const stem = plain.slice(0, marker.index).trim();
  if ((!stem.endsWith("?") && !marker[1]) || !stem.replace(/\?$/, "").trim()) return null;
  return { number: match?.[1] ?? null, text: question };
}
