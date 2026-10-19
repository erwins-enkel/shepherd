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

/** A message the operator sent from the composer, shown until the transcript logs it. */
export interface PendingSend {
  text: string;
  /** ms epoch (browser clock) of the send. */
  at: number;
}

/** Browser and server clocks may disagree; a logged echo may carry a slightly earlier stamp. */
const ECHO_SKEW_MS = 60_000;

/** The sends the transcript has not logged yet: no user row with the same text, stamped no
 *  earlier than the skew window before the send (an older identical message is not the echo). */
export function unsettled(pending: PendingSend[], entries: ChatEntry[]): PendingSend[] {
  return pending.filter(
    (p) =>
      !entries.some(
        (e) => e.kind === "user" && e.text.trim() === p.text.trim() && e.ts >= p.at - ECHO_SKEW_MS,
      ),
  );
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
