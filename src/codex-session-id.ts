/**
 * Discover the provider-native Codex session id (the rollout UUID resumed via `codex resume <id>`)
 * for an isolated Shepherd worktree, by reading rollout `session_meta` headers under
 * `$CODEX_HOME/sessions`.
 *
 * The rollout header is the ground truth for the id (the Codex `state_N.sqlite` cache lags and its
 * filename drifts across versions). Codex writes it as line 1 of every rollout jsonl:
 *   {"type":"session_meta","payload":{"session_id":"<uuid>","id":"<uuid>","cwd":"<abs>","source":"cli",…}}
 *
 * Two constraints make this reliable for an ISOLATED worktree (unique cwd):
 *  - The cwd match is a lexical `normalize()` compare against `worktreePath`, which is already
 *    canonical (Shepherd's `safeRepoDir` realpath-resolves repoPath and the worktree joins from it)
 *    and which Codex records canonically. No `realpath` is performed on the candidate cwd — this runs
 *    BEFORE the worktree is re-created at restore time, so the path may not exist on disk.
 *  - Interactive discovery requires `source === "cli"`. Reviewer discovery explicitly selects
 *    `source === "exec"` and also requires the row-specific correlation marker in a user message,
 *    so concurrent role spawns in the same cwd cannot be confused.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { normalize } from "node:path";

import { codexHome, listRolloutFiles } from "./codex-usage";

interface SessionMetaHeader {
  id: string | null;
  cwd: string;
  source: string | null;
}

export interface CodexSessionDiscoveryOptions {
  source?: "cli" | "exec";
  correlationMarker?: string;
}

export function codexReviewerCorrelationMarker(reviewerSessionId: string): string {
  return `[SHEPHERD_REVIEWER_SPAWN_ID:${reviewerSessionId}]`;
}

/**
 * The newest rollout with the requested source whose recorded cwd equals `worktreePath`, among
 * rollouts modified at/after `notBeforeMs`; exec discovery additionally requires its correlation
 * marker. The scan is UNBOUNDED over that mtime window (callers must not cap it) so a busy machine
 * can't push the target rollout out of view.
 */
export function findCodexSessionId(
  worktreePath: string,
  notBeforeMs: number,
  home = codexHome(),
  options: CodexSessionDiscoveryOptions = {},
): string | null {
  const target = normalize(worktreePath);
  const source = options.source ?? "cli";
  if (source === "exec" && !options.correlationMarker) return null;
  // listRolloutFiles is newest-first by mtime, so the first cwd+cli match is the newest one — and the
  // first file older than the window means every remaining file is too: stop rather than scan the tail.
  for (const { path, mtimeMs } of listRolloutFiles(home)) {
    if (mtimeMs < notBeforeMs) break;
    const meta = readSessionMeta(path);
    if (!meta || meta.source !== source || !meta.id) continue;
    if (normalize(meta.cwd) !== target) continue;
    if (source === "exec" && !hasMarkedUserMessage(path, options.correlationMarker as string))
      continue;
    return meta.id;
  }
  return null;
}

/** Match the marker only at the start of a user-authored record. Codex may inject its own user
 *  prelude before the positional exec prompt, so scan user records rather than stopping at the
 *  first one; assistant/tool output can never satisfy the match. */
function hasMarkedUserMessage(path: string, marker: string): boolean {
  const content = readPrefix(path, 1024 * 1024);
  if (!content) return false;
  for (const line of content.split("\n").slice(1)) {
    if (!line) continue;
    const record = parseRolloutRecord(line);
    if (record && userMessageText(record)?.startsWith(marker)) return true;
  }
  return false;
}

interface RolloutRecord {
  type?: unknown;
  payload?: unknown;
}

interface RolloutPayload {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  message?: unknown;
  text?: unknown;
}

function parseRolloutRecord(line: string): RolloutRecord | null {
  try {
    const record: unknown = JSON.parse(line);
    return record && typeof record === "object" ? (record as RolloutRecord) : null;
  } catch {
    return null;
  }
}

function userMessageText(record: RolloutRecord): string | null {
  if (!record.payload || typeof record.payload !== "object") return null;
  const payload = record.payload as RolloutPayload;
  return responseItemUserText(record.type, payload) ?? eventUserText(record.type, payload);
}

function responseItemUserText(recordType: unknown, payload: RolloutPayload): string | null {
  if (recordType !== "response_item" || payload.type !== "message" || payload.role !== "user")
    return null;
  if (!Array.isArray(payload.content)) return null;
  return payload.content.map(contentPartText).join("");
}

function contentPartText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function eventUserText(recordType: unknown, payload: RolloutPayload): string | null {
  if (recordType !== "event_msg" || payload.type !== "user_message") return null;
  if (typeof payload.message === "string") return payload.message;
  return typeof payload.text === "string" ? payload.text : null;
}

/** Parse line 1 of a rollout jsonl (the `session_meta` record). Tolerant: null on any read/parse
 *  failure or a non-`session_meta` / malformed header (legacy or partially-written file). */
function readSessionMeta(path: string): SessionMetaHeader | null {
  const line = readFirstLine(path);
  if (!line) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as { type?: unknown; payload?: unknown };
  if (rec.type !== "session_meta" || !rec.payload || typeof rec.payload !== "object") return null;
  const p = rec.payload as { session_id?: unknown; id?: unknown; cwd?: unknown; source?: unknown };
  const cwd = typeof p.cwd === "string" ? p.cwd : null;
  if (!cwd) return null;
  const id =
    typeof p.session_id === "string" ? p.session_id : typeof p.id === "string" ? p.id : null;
  const source = typeof p.source === "string" ? p.source : null;
  return { id, cwd, source };
}

/** Read the first line of a file without loading the whole thing — a rollout grows to many MB, but
 *  its `session_meta` header (line 1) carries the full Codex system prompt so it can still be tens
 *  of KB. One bounded read (512 KiB) covers any realistic header; a header larger than that, or with
 *  no newline in the buffer, yields a truncated string that simply fails to JSON-parse (→ skipped). */
function readFirstLine(path: string): string | null {
  const text = readPrefix(path, 512 * 1024);
  if (text === null) return null;
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

function readPrefix(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSyncQuiet(fd);
  }
}

/** closeSync that never throws (fd may already be gone). */
function closeSyncQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}
