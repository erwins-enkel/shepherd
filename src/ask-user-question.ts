// AskUserQuestion as data in, key presses out (issue #3165).
//
// A PreToolUse hook hands us the tool's `tool_input`; the operator answers in a native panel; the
// answer is TYPED into the real PTY as the key presses the Claude Code dialog expects, so the
// feature stays inside "steer by typing" (PRD §3). PostToolUse's `tool_response.answers` then
// verifies what actually arrived.
//
// Key sequences below were measured against Claude Code 2.1.301's TUI (tmux spike, verified end to
// end against `toolUseResult.answers`):
//  - every key must be its OWN pty write — one coalesced write ("212\x1b[B…") reads as a paste and
//    breaks the dialog; a 50 ms gap worked, ASK_KEY_GAP_MS leaves headroom;
//  - the cursor starts on row 1 of each question; digits select/toggle without moving it;
//  - single: digit N picks option N and advances; Other = digit n+1 focuses the text row, the text,
//    then Enter;
//  - multi: digit N toggles; the Other row is reached with Down×n from row 1, Down once more lands
//    on the Next/Submit row, Enter there advances;
//  - more than one question, or any multi, ends on a "Review your answers" screen whose first
//    option is "Submit answers"; a single-question single-select submits on its own.
//  - `answers` maps question text → the label; multi joins labels in OPTION order with ", ", the
//    Other text last; Other alone is the raw text.

import type { RawAnswer } from "./plan-gate";

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

/** An AskUserQuestion dialog the agent is waiting on, keyed by its tool_use id. */
export interface PendingAsk {
  toolUseId: string;
  questions: AskQuestion[];
}

/** One question's validated answer: chosen option indices (ascending) and/or the Other text. */
export interface ResolvedAskAnswer {
  question: AskQuestion;
  optionIndices: number[];
  other: string | null;
}

export type AskAnswerResult = "verified" | "mismatch" | "unverified";

/** Gap between two pty writes of a key sequence (spike: 50 ms suffices, coalescing breaks). */
export const ASK_KEY_GAP_MS = 120;
const DOWN = "\x1b[B";
const ENTER = "\r";
const OTHER_MAX = 500;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseQuestion(raw: unknown): AskQuestion | null {
  const q = obj(raw);
  if (!q || typeof q.question !== "string" || !q.question.trim()) return null;
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return null;
  const options: AskOption[] = [];
  for (const o of q.options) {
    const opt = obj(o);
    if (!opt || typeof opt.label !== "string" || !opt.label.trim()) return null;
    // `preview` and any other field are tolerated and ignored.
    options.push({
      label: opt.label,
      description: typeof opt.description === "string" ? opt.description : "",
    });
  }
  return {
    question: q.question,
    header: typeof q.header === "string" ? q.header : "",
    options,
    multiSelect: q.multiSelect === true,
  };
}

/**
 * Validate an untrusted AskUserQuestion `tool_input`. 1–4 questions of 2–4 labelled options each.
 * Unknown fields are ignored; a question shape the panel cannot type (e.g. a flagged "form" kind
 * without options) yields null — no panel, the terminal still works. Never throws.
 */
export function parseAskInput(input: unknown): AskQuestion[] | null {
  const qs = obj(input)?.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return null;
  const out: AskQuestion[] = [];
  for (const raw of qs) {
    const q = parseQuestion(raw);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

/** Other text made safe to type: no control chars (a newline would press Enter, ESC would cancel),
 *  whitespace collapsed, trimmed, capped. Empty ⇒ null. */
export function sanitizeOtherText(text: string): string | null {
  const clean = text.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, OTHER_MAX).trim() : null;
}

/**
 * Resolve the panel's answers (`questionId` = the question's index as a string) against the
 * questions. Every question needs an answer: single = exactly one option OR Other text; multi = at
 * least one option and/or Other text. Returns null on anything invalid (fail closed).
 */
export function resolveAskAnswers(
  questions: AskQuestion[],
  answers: RawAnswer[],
): ResolvedAskAnswer[] | null {
  const byIndex = new Map<string, RawAnswer>();
  for (const a of answers) {
    if (byIndex.has(a.questionId)) return null;
    byIndex.set(a.questionId, a);
  }
  if (byIndex.size !== questions.length) return null;
  const out: ResolvedAskAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const a = byIndex.get(String(i));
    const resolved = a ? resolveOne(q, a) : null;
    if (!resolved) return null;
    out.push(resolved);
  }
  return out;
}

/** One question's answer, or null when it does not fit the question. */
function resolveOne(q: AskQuestion, a: RawAnswer): ResolvedAskAnswer | null {
  const raw = a.optionIndices ?? [];
  if (!Array.isArray(raw)) return null;
  const indices = [...new Set(raw)].sort((x, y) => x - y);
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n < q.options.length;
  if (indices.length !== raw.length || !indices.every(inRange)) return null;
  const other = typeof a.text === "string" ? sanitizeOtherText(a.text) : null;
  const picked = indices.length + (other ? 1 : 0);
  if (q.multiSelect ? picked === 0 : picked !== 1) return null;
  return { question: q, optionIndices: indices, other };
}

/** The pty writes that answer the dialog, one key per entry (see the module header). */
export function askKeySequence(answers: ResolvedAskAnswer[]): string[] {
  const keys: string[] = [];
  for (const a of answers) {
    const q = a.question;
    const n = q.options.length;
    if (!q.multiSelect) {
      if (a.other) keys.push(String(n + 1), a.other, ENTER);
      else keys.push(String((a.optionIndices[0] ?? 0) + 1));
      continue;
    }
    for (const idx of a.optionIndices) keys.push(String(idx + 1));
    if (a.other) {
      keys.push(String(n + 1), ...Array<string>(n).fill(DOWN), a.other, DOWN);
    } else {
      keys.push(...Array<string>(n + 1).fill(DOWN));
    }
    keys.push(ENTER);
  }
  if (answers.length > 1 || answers.some((a) => a.question.multiSelect)) keys.push("1");
  return keys;
}

/** What `tool_response.answers` must read once the typed answer landed. */
export function expectedAskAnswers(answers: ResolvedAskAnswer[]): Record<string, string> {
  return Object.fromEntries(
    answers.map((a) => {
      const parts = a.optionIndices.map((idx) => a.question.options[idx]?.label ?? "");
      if (a.other) parts.push(a.other);
      return [a.question.question, parts.join(", ")];
    }),
  );
}

/** Normalize an untrusted `tool_response.answers` (values string, or string[] for multi). */
export function normalizeAskAnswers(raw: unknown): Record<string, string> | null {
  const o = obj(raw);
  if (!o) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v.join(", ");
  }
  return out;
}

export function askAnswersMatch(
  expected: Record<string, string>,
  actual: Record<string, string>,
): boolean {
  const keys = Object.keys(expected);
  return (
    keys.length === Object.keys(actual).length &&
    keys.every((k) => actual[k]?.trim() === expected[k]?.trim())
  );
}
