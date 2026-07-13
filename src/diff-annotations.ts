// Per-line Diff-tab annotations (#1699). Derives two read-only, EPHEMERAL sources from data
// that already exists — no new storage:
//
//  1. Agent spans  — the agent's own reasoning, anchored to the changed line its edit produced.
//     Sourced from the session transcript: Phase-0 (see .shepherd-plan.md) established that Claude
//     Code writes each content block as its OWN assistant JSONL line (thinking / text / tool_use
//     separate), sharing a `message.id` per turn, and that `thinking` is absent in practice — so
//     reasoning is read from the turn's `text` blocks (grouped by `message.id`), and each edit is
//     anchored by a UNIQUE multi-line content signature (ambiguity → DROP, never anchor wrong).
//  2. Review findings — the session's Critic findings, routed via the shared critic-core
//     `attributeFinding` classifier: a finding attributable to a diff file → per-file banner;
//     unattributed OR out-of-diff → panel banner (NEVER dropped here — see the endpoint/client).
//
// This module is PURE + sync (except `readTranscriptTail`, itself sync fs) so the builder is unit
// testable; the endpoint (server.ts) does the async IO (computeDiff / getReview) and calls in.

import { attributeFinding } from "./critic-core";
import { readTranscriptTail } from "./activity";
import type { DiffFile } from "./types";

/** One Diff-tab annotation on the wire. `kind:"agent"` carries a line anchor (`side`+`lineNumber`)
 *  and the tool; `kind:"review"` is file-level (`path`) or panel-level (`path:""`), no anchor.
 *  NOTE: named `DiffNote`, not `DiffAnnotation` — the UI already owns a `DiffAnnotation` type
 *  (visual-block prose note). `text` is VERBATIM agent/critic content — never HTML (client renders
 *  it as a text node only). */
export interface DiffNote {
  path: string;
  kind: "agent" | "review";
  text: string;
  side?: "additions" | "deletions";
  lineNumber?: number;
  tool?: string;
}

// ── tuning knobs (all conservative; the design's honest limits live here) ──────────────────────
const SIG_MAX_LINES = 3; // signature = up to N leading non-blank lines of the edit's new text
const MIN_SINGLE_LINE_SIG = 20; // a 1-line signature must be at least this long (else too ambiguous)
const MIN_REASON_LEN = 20; // reasoning shorter than this is treated as trivial → drop the note
const REASON_MAX = 240; // clamp reasoning to ~this many chars (word boundary), then ellipsize
const PER_FILE_AGENT_CAP = 8; // at most this many agent notes per file (avoid a wall on churny files)

/** Normalize a line for signature comparison: trim outer whitespace (so indentation differences
 *  between an edit's `new_string` and the diff's rendered content never block a match). */
function norm(s: string): string {
  return s.trim();
}

/** Up to `SIG_MAX_LINES` leading NON-BLANK lines of `text`, normalized — the anchoring signature. */
function signatureLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const n = norm(raw);
    if (n === "") continue;
    out.push(n);
    if (out.length >= SIG_MAX_LINES) break;
  }
  return out;
}

/** New-side view of a file's diff: every add/ctx line in document order, with its new-side line
 *  number and whether it is an actual addition. `del` lines (no new-side number) are skipped. This
 *  is the sequence an edit's `new_string` signature is matched against. */
function newSideLines(file: DiffFile): { no: number; content: string; isAdd: boolean }[] {
  const rows: { no: number; content: string; isAdd: boolean }[] = [];
  for (const hunk of file.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.kind === "del") continue;
      if (line.newNo === undefined) continue;
      rows.push({ no: line.newNo, content: line.content, isAdd: line.kind === "add" });
    }
  }
  return rows;
}

/**
 * Anchor an edit's `newString` to a changed line, or return null (DROP). Requires a UNIQUE
 * consecutive match of the signature against the file's new-side lines, AND that the match covers
 * at least one real added line (so the anchor is genuinely in the diff, not pure context). Returns
 * the new-side line number of the first added line within the matched run. A 1-line signature must
 * clear `MIN_SINGLE_LINE_SIG` chars (a lone `}` / `return;` is too ambiguous to anchor).
 */
export function anchorEdit(
  newString: string,
  rows: { no: number; content: string; isAdd: boolean }[],
): number | null {
  const sig = signatureLines(newString);
  if (sig.length === 0) return null;
  if (sig.length === 1 && sig[0]!.length < MIN_SINGLE_LINE_SIG) return null;
  const normed = rows.map((r) => norm(r.content));
  const starts: number[] = [];
  for (let i = 0; i + sig.length <= normed.length; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) {
      if (normed[i + j] !== sig[j]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  if (starts.length !== 1) return null; // 0 = no match, >1 = ambiguous → never anchor wrong
  const s = starts[0]!;
  for (let j = 0; j < sig.length; j++) {
    if (rows[s + j]!.isAdd) return rows[s + j]!.no;
  }
  return null; // signature matched only context lines → not actually in the diff → drop
}

/** Clamp reasoning to `REASON_MAX` chars at a word boundary, ellipsizing when cut. */
function clampReason(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= REASON_MAX) return t;
  const cut = t.slice(0, REASON_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > REASON_MAX * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/** One extracted edit operation: the file it targeted (repo-relative), the tool, the new text to
 *  anchor, and the turn's reasoning. Exported for the extractor's test. */
export interface TranscriptEdit {
  path: string; // repo-relative (worktree prefix stripped)
  tool: string; // "Edit" | "MultiEdit" | "Write"
  newString: string;
  reasoning: string;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/** Repo-relative path for a transcript tool `file_path` (absolute), or null if outside the
 *  worktree / missing. */
function relPath(filePath: unknown, worktreePath: string): string | null {
  if (typeof filePath !== "string" || filePath === "") return null;
  const root = worktreePath.endsWith("/") ? worktreePath : worktreePath + "/";
  if (filePath === worktreePath) return null;
  if (!filePath.startsWith(root)) return null;
  return filePath.slice(root.length);
}

type Turn = {
  text: string[];
  think: string[];
  edits: { tool: string; input: Record<string, unknown> }[];
};

/** Parse one JSONL line as an assistant message with its turn id + content blocks, or null. */
function parseAssistantLine(
  line: string,
): { id: string; content: Array<Record<string, unknown>> } | null {
  const t = line.trim();
  if (t === "") return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  const rec = o as { type?: unknown; message?: { id?: unknown; content?: unknown } };
  if (rec.type !== "assistant" || !Array.isArray(rec.message?.content)) return null;
  const id = typeof rec.message?.id === "string" ? rec.message.id : "";
  if (id === "") return null;
  return { id, content: rec.message!.content as Array<Record<string, unknown>> };
}

/** Fold a message's content blocks into its turn: text / thinking → reasoning, edit tools → edits. */
function addBlocksToTurn(turn: Turn, content: Array<Record<string, unknown>>): void {
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim())
      turn.text.push(b.text.trim());
    else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim())
      turn.think.push(b.thinking.trim());
    else if (b.type === "tool_use" && typeof b.name === "string" && EDIT_TOOLS.has(b.name))
      turn.edits.push({ tool: b.name, input: (b.input as Record<string, unknown>) ?? {} });
  }
}

/** The non-empty new-text strings a single edit tool contributes: MultiEdit → each `edits[].new_string`,
 *  Write → `content`, Edit → `new_string`. */
function editNewStrings(tool: string, input: Record<string, unknown>): string[] {
  const raw =
    tool === "MultiEdit" && Array.isArray(input.edits)
      ? (input.edits as Array<Record<string, unknown>>).map((e) => e?.new_string)
      : [tool === "Write" ? input.content : input.new_string];
  return raw.filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

/** The edit ops a single turn contributes: each edit tool × each of its new-text strings, tagged
 *  with the turn's reasoning (thinking preferred over text). Edits outside the worktree are skipped. */
function turnEdits(turn: Turn, worktreePath: string): TranscriptEdit[] {
  const reasoning = (turn.think.join(" ") || turn.text.join(" ")).trim();
  const ops: TranscriptEdit[] = [];
  for (const e of turn.edits) {
    const path = relPath(e.input.file_path, worktreePath);
    if (path === null) continue;
    for (const newString of editNewStrings(e.tool, e.input))
      ops.push({ path, tool: e.tool, newString, reasoning });
  }
  return ops;
}

/**
 * Parse a transcript into edit operations with their turn reasoning. Groups assistant lines by
 * `message.id` (each content block is its own JSONL line — Phase 0), so a turn's `text` blocks
 * (preferring `thinking` when present, though it is absent in practice) supply the reasoning for
 * every edit in that turn. Edit → one op; MultiEdit → one op per `edits[]`; Write → the `content`.
 * PURE (operates on the passed text).
 */
export function parseTranscriptEdits(text: string, worktreePath: string): TranscriptEdit[] {
  const turns = new Map<string, Turn>();
  const order: string[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseAssistantLine(line);
    if (!parsed) continue;
    let turn = turns.get(parsed.id);
    if (!turn) {
      turn = { text: [], think: [], edits: [] };
      turns.set(parsed.id, turn);
      order.push(parsed.id);
    }
    addBlocksToTurn(turn, parsed.content);
  }
  return order.flatMap((id) => turnEdits(turns.get(id)!, worktreePath));
}

/** Build the agent-span notes: anchor each extracted edit against its diff file's new-side lines,
 *  dropping trivial reasoning, unanchorable edits, per-line/text duplicates, and anything beyond
 *  the per-file cap. PURE. */
export function buildAgentNotes(edits: TranscriptEdit[], files: DiffFile[]): DiffNote[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const rowsCache = new Map<string, { no: number; content: string; isAdd: boolean }[]>();
  const perFileCount = new Map<string, number>();
  const seen = new Set<string>();
  const notes: DiffNote[] = [];
  for (const e of edits) {
    const reason = clampReason(e.reasoning);
    if (reason.length < MIN_REASON_LEN) continue; // trivial/empty → drop
    const file = byPath.get(e.path);
    if (!file || file.binary || file.truncated) continue; // no anchorable hunks
    let rows = rowsCache.get(e.path);
    if (!rows) {
      rows = newSideLines(file);
      rowsCache.set(e.path, rows);
    }
    const line = anchorEdit(e.newString, rows);
    if (line === null) continue;
    const dedupe = `${e.path} ${line} ${reason}`;
    if (seen.has(dedupe)) continue;
    const count = perFileCount.get(e.path) ?? 0;
    if (count >= PER_FILE_AGENT_CAP) continue;
    seen.add(dedupe);
    perFileCount.set(e.path, count + 1);
    notes.push({
      path: e.path,
      kind: "agent",
      text: reason,
      side: "additions",
      lineNumber: line,
      tool: e.tool,
    });
  }
  return notes;
}

/** Build the review notes from already-scope-filtered critic findings. Routes via the shared
 *  `attributeFinding` discriminant: `matched` → per-file (keyed to the DiffFile.path); BOTH
 *  `unattributed` and `out-of-diff` → panel-level (`path:""`) — NEVER dropped here (the findings
 *  already passed the critic's scope gate; a base skew must not hide one). PURE. */
export function buildReviewNotes(findings: string[], filePaths: string[]): DiffNote[] {
  const notes: DiffNote[] = [];
  for (const f of findings) {
    const { attribution, path, text } = attributeFinding(f, filePaths);
    notes.push({
      path: attribution === "matched" ? path : "",
      kind: "review",
      text: attribution === "matched" ? text : f,
    });
  }
  return notes;
}

/** Full builder: agent notes (from the transcript) + review notes (from findings), against a
 *  computed diff's files. `transcriptPath` may be "" (pre-feature session, no pinned id) → no
 *  agent notes. PURE except the sync `readTranscriptTail`. */
export function buildDiffNotes(input: {
  files: DiffFile[];
  worktreePath: string;
  transcriptPath: string;
  findings: string[];
}): DiffNote[] {
  const { files, worktreePath, transcriptPath, findings } = input;
  const filePaths = files.map((f) => f.path);
  let agent: DiffNote[] = [];
  if (transcriptPath !== "") {
    let transcript: string;
    try {
      transcript = readTranscriptTail(transcriptPath);
    } catch {
      transcript = ""; // missing/unreadable transcript → no agent notes (never an error)
    }
    if (transcript !== "")
      agent = buildAgentNotes(parseTranscriptEdits(transcript, worktreePath), files);
  }
  return [...agent, ...buildReviewNotes(findings, filePaths)];
}
