// Detect a *pending* OAuth authorization URL in a Claude Code session transcript.
//
// When an MCP server needs OAuth (e.g. Notion, Vercel), the agent prints a long
// `…/authorize?response_type=code&client_id=…` URL and blocks, asking the operator to
// open it in their browser and paste back the localhost callback. Claude's TUI word-wraps
// that URL across several indented terminal lines, so it is un-clickable and un-copyable
// in the PTY buffer — but it appears *verbatim, un-wrapped* in the JSONL transcript.
//
// Step-0 capture (real Vercel/Notion MCP flows) showed the URL lands in TWO record shapes
// in the same flow — an assistant `text` block (Claude relaying it) AND a `tool_result`
// block carried inside a `role:"user"` message (the raw MCP payload). So this scans BOTH;
// scanning only assistant-side text (which excludes `role:"user"`) would miss the
// tool_result delivery. Pure + transcript-only so it is unit-testable without the poller.

import { eachJsonlObject } from "./jsonl";

// URL token: http(s) up to the first whitespace/quote/bracket/backtick. Query chars
// (& = % + . _ ~ : / ? #) are all inside this class, so a long authorize URL is captured
// whole. Trailing sentence punctuation is stripped below.
const URL_RE = /https?:\/\/[^\s"'`<>\\)\]}]+/g;

/** Strip trailing sentence/markdown punctuation a URL token may have swallowed. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?)\]}>"']+$/, "");
}

/**
 * True when `u` is an OAuth *authorization* endpoint (not the localhost callback the
 * operator pastes back). Match on the authorize path or the PKCE/response-type query, so
 * a `/callback?code=…` return URL is correctly excluded.
 */
function isAuthUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (/\/(oauth\/)?authorize\b/i.test(url.pathname)) return true;
  if (url.searchParams.get("response_type") === "code") return true;
  if (url.searchParams.has("code_challenge")) return true;
  return false;
}

/** First authorization URL in a blob of text, or null. */
function firstAuthUrl(text: string): string | null {
  const matches = text.match(URL_RE);
  if (!matches) return null;
  for (const raw of matches) {
    const u = trimUrl(raw);
    if (isAuthUrl(u)) return u;
  }
  return null;
}

/** Text carried by a `tool_result` block, whose `content` is either a string or an
 *  array of `{type:"text", text}` blocks (both shapes occur in real transcripts). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "",
      )
      .join(" ");
  }
  return "";
}

interface Rec {
  role: string;
  content: unknown;
}

/** Normalize a raw JSONL object to `{ role, content }`; null when it carries no message. */
function toRec(o: unknown): Rec | null {
  const rec = o as { message?: { role?: unknown; content?: unknown }; type?: unknown } | undefined;
  const content = rec?.message?.content;
  if (content === undefined) return null;
  const role = typeof rec?.message?.role === "string" ? rec.message.role : String(rec?.type ?? "");
  return { role, content };
}

/** Last authorize URL across an assistant record's `text` blocks, or null. */
function assistantAuthUrl(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  let url: string | null = null;
  for (const b of content) {
    if ((b as { type?: unknown })?.type !== "text") continue;
    const found = firstAuthUrl(String((b as { text?: unknown }).text ?? ""));
    if (found) url = found;
  }
  return url;
}

/**
 * A user record's effect on the pending URL. A user message with no tool_result is
 * operator input → clears (`{ clear: true }`); otherwise the last authorize URL across its
 * tool_result blocks (or null).
 */
function userAuthEffect(content: unknown): { clear: boolean; url: string | null } {
  const toolResults = Array.isArray(content)
    ? content.filter((b) => (b as { type?: unknown })?.type === "tool_result")
    : [];
  if (toolResults.length === 0) return { clear: true, url: null };
  let url: string | null = null;
  for (const b of toolResults) {
    const found = firstAuthUrl(toolResultText((b as { content?: unknown }).content));
    if (found) url = found;
  }
  return { clear: false, url };
}

/**
 * Return the authorization URL the agent is *currently* waiting on the operator to open,
 * or null. Walks the transcript oldest→newest and tracks the pending URL:
 *
 *  - an assistant `text` block or a `tool_result` block carrying an authorize URL SETS it;
 *  - a plain operator input (a `role:"user"` message with no tool_result — a string or a
 *    typed `text` turn) CLEARS it, because the operator has responded to the prompt.
 *
 * So a prior, already-answered auth URL still sitting in the tail is not resurfaced when the
 * agent later blocks for an unrelated reason. Malformed/blank lines are skipped.
 */
export function detectAuthUrl(rawJsonl: string): string | null {
  let pending: string | null = null;
  for (const o of eachJsonlObject(rawJsonl)) {
    const rec = toRec(o);
    if (!rec) continue;
    if (rec.role === "assistant") {
      pending = assistantAuthUrl(rec.content) ?? pending;
    } else if (rec.role === "user") {
      const { clear, url } = userAuthEffect(rec.content);
      if (clear) pending = null;
      else pending = url ?? pending;
    }
    // system / other roles: ignored
  }
  return pending;
}
