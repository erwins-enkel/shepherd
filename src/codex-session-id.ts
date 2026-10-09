/**
 * Codex rollout readers. Task automation resolves launch provenance with
 * findCodexLaunchSessionId and persists the attributed session_meta id; every later reader —
 * native resume and the transcript readers alike — goes through that id, never cwd recency.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { basename, normalize } from "node:path";

import { codexHome, listRolloutFiles } from "./codex-usage";

export interface SessionMetaHeader {
  id: string | null;
  cwd: string;
  source: string | null;
}

/** Generous negative clock-skew allowance when filtering rollout files by mtime against a session's
 *  `createdAt` — a rollout is written just after spawn, so its mtime is >= createdAt on the same
 *  machine; this only guards against tiny FS/clock jitter so a legit rollout is never excluded.
 *  Lives here, with the scan, so the live capture and the boot backfill share one window. */
export const CODEX_ID_SKEW_MS = 5 * 60_000;

/**
 * The rollout file of the Codex conversation `id`, or null. Codex names every rollout
 * `rollout-<timestamp>-<id>.jsonl` and `codex resume <id>` appends to that same file, so the name
 * alone locates it — a stat-only walk, no header scan. The header is still checked so a renamed or
 * foreign file can never be served as this conversation.
 */
export function findCodexRolloutById(id: string, home = codexHome()): string | null {
  const suffix = `-${id}.jsonl`;
  for (const { path } of listRolloutFiles(home)) {
    if (basename(path).endsWith(suffix) && readSessionMeta(path)?.id === id) return path;
  }
  return null;
}

/** A fresh launch gets its own marker, including when an existing task replaces its agent.
 * It is prepended outside operator-authored text and matched only in the initial user turn. */
export function codexLaunchMarker(launchId: string): string {
  return `<shepherd-session launch="${launchId}" />\n`;
}

/** A rollout file together with its parsed `session_meta` header. */
export interface RolloutHeader extends SessionMetaHeader {
  path: string;
  mtimeMs: number;
}

/** Interactive TUI rollouts: `cli`, or `vscode` when Codex 0.160+ runs the TUI through its shared
 *  daemon. Headless role spawns are `exec`; subagent threads carry an object source (parsed as
 *  null). The launch marker, not this label, proves ownership — this only keeps roles out. */
function isInteractiveSource(source: string | null): boolean {
  return source !== null && source !== "exec";
}

/** Every readable rollout header under `$CODEX_HOME/sessions`, newest-first by mtime, read lazily
 *  so a caller that stops early never parses the older tail. */
function* rolloutHeaders(home: string): Generator<RolloutHeader> {
  for (const { path, mtimeMs } of listRolloutFiles(home)) {
    const meta = readSessionMeta(path);
    if (meta) yield { ...meta, path, mtimeMs };
  }
}

/** The launch-provenance rule over newest-first `headers`: the one interactive conversation in
 *  `worktreePath`, modified at/after `notBeforeMs`, whose first user turn opens with the launch
 *  marker. Multiple distinct conversations carrying the marker (e.g. a copied/forked history) are
 *  ambiguous and must stay manual. */
export function launchSessionIdAmong(
  headers: Iterable<RolloutHeader>,
  worktreePath: string,
  launchId: string,
  notBeforeMs: number,
): string | null {
  const target = normalize(worktreePath);
  const marker = codexLaunchMarker(launchId);
  const ids = new Set<string>();
  for (const h of headers) {
    if (h.mtimeMs < notBeforeMs) break;
    if (!h.id || !isInteractiveSource(h.source) || normalize(h.cwd) !== target) continue;
    if (rolloutHasLaunchMarker(h.path, marker)) ids.add(h.id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Resolve by launch provenance, never by cwd recency. A bounded prefix read avoids loading
 * growing transcripts; an incomplete/oversized prefix simply cannot resolve. */
export function findCodexLaunchSessionId(
  worktreePath: string,
  launchId: string,
  notBeforeMs: number,
  home = codexHome(),
): string | null {
  return launchSessionIdAmong(rolloutHeaders(home), worktreePath, launchId, notBeforeMs);
}

/** Bound disk work independently of transcript size. */
function readRolloutPrefix(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(1024 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSyncQuiet(fd);
  }
}

function rolloutHasLaunchMarker(path: string, marker: string): boolean {
  try {
    for (const line of readRolloutPrefix(path).split("\n").slice(0, -1)) {
      const record = JSON.parse(line);
      if (record.type !== "response_item" || record.payload?.type !== "message") continue;
      const message = record.payload;
      if (message.role === "assistant") return false;
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      if (
        message.content.some(
          (part: { type?: string; text?: string }) =>
            part.type === "input_text" && part.text?.startsWith(marker),
        )
      )
        return true;
    }
  } catch {
    // A malformed or incomplete record cannot establish launch provenance.
  }
  return false;
}

/** Parse line 1 of a rollout jsonl (the `session_meta` record). Tolerant: null on any read/parse
 *  failure or a non-`session_meta` / malformed header (legacy or partially-written file). Shared
 *  with the exec-source rollout scan in `codex-activity.ts` (issue #1816). */
export function readSessionMeta(path: string): SessionMetaHeader | null {
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
  // The thread id identifies the resume target; a session root can be shared by forks.
  const id =
    typeof p.id === "string" ? p.id : typeof p.session_id === "string" ? p.session_id : null;
  const source = typeof p.source === "string" ? p.source : null;
  return { id, cwd, source };
}

/** Read the first line of a file without loading the whole thing — a rollout grows to many MB, but
 *  its `session_meta` header (line 1) carries the full Codex system prompt so it can still be tens
 *  of KB. One bounded read (512 KiB) covers any realistic header; a header larger than that, or with
 *  no newline in the buffer, yields a truncated string that simply fails to JSON-parse (→ skipped). */
function readFirstLine(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(512 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
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
