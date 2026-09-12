/**
 * Codex rollout readers. Task automation resolves launch provenance with
 * findCodexLaunchSessionId; cwd-recency helpers remain for legacy transcript display only.
 * Native resume always uses the attributed session_meta id.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { normalize } from "node:path";

import { codexHome, listRolloutFiles } from "./codex-usage";

export interface SessionMetaHeader {
  id: string | null;
  cwd: string;
  source: string | null;
}

/** A resolved interactive rollout: its Codex-native id AND the file it lives in. */
export interface CodexRollout {
  id: string;
  path: string;
}

/** Generous negative clock-skew allowance when filtering rollout files by mtime against a session's
 *  `createdAt` — a rollout is written just after spawn, so its mtime is >= createdAt on the same
 *  machine; this only guards against tiny FS/clock jitter so a legit rollout is never excluded.
 *  Lives here, with the scan, because every caller's window MUST agree: the id the resume path
 *  captures and the rollout the transcript readers show have to be the same conversation. */
export const CODEX_ID_SKEW_MS = 5 * 60_000;

/**
 * The newest interactive (`source === "cli"`) rollout whose recorded cwd equals `worktreePath`,
 * among rollouts modified at/after `notBeforeMs`; null if none. The scan is UNBOUNDED over that
 * mtime window (callers must not cap it) so a busy machine can't push the target rollout out of view.
 *
 * This legacy display heuristic is not proof of ownership and must never select a resume target.
 */
export function findCodexRollout(
  worktreePath: string,
  notBeforeMs: number,
  home = codexHome(),
): CodexRollout | null {
  const target = normalize(worktreePath);
  // listRolloutFiles is newest-first by mtime, so the first cwd+cli match is the newest one — and the
  // first file older than the window means every remaining file is too: stop rather than scan the tail.
  for (const { path, mtimeMs } of listRolloutFiles(home)) {
    if (mtimeMs < notBeforeMs) break;
    const meta = readSessionMeta(path);
    if (!meta || meta.source !== "cli" || !meta.id) continue;
    if (normalize(meta.cwd) === target) return { id: meta.id, path };
  }
  return null;
}

/** {@link findCodexRollout}'s id alone; not safe for automated session targeting. */
export function findCodexSessionId(
  worktreePath: string,
  notBeforeMs: number,
  home = codexHome(),
): string | null {
  return findCodexRollout(worktreePath, notBeforeMs, home)?.id ?? null;
}

/** A fresh launch gets its own marker, including when an existing task replaces its agent.
 * It is prepended outside operator-authored text and matched only in the initial user turn. */
export function codexLaunchMarker(launchId: string): string {
  return `<shepherd-session launch="${launchId}" />\n`;
}

/** Resolve by launch provenance, never by cwd recency. Multiple distinct conversations carrying
 * the marker (e.g. a copied/forked history) are ambiguous and must stay manual. A bounded prefix
 * read avoids loading growing transcripts; an incomplete/oversized prefix simply cannot resolve. */
export function findCodexLaunchSessionId(
  worktreePath: string,
  launchId: string,
  notBeforeMs: number,
  home = codexHome(),
): string | null {
  const ids = new Set<string>();
  for (const { path, mtimeMs } of listRolloutFiles(home)) {
    if (mtimeMs < notBeforeMs) break;
    const meta = readSessionMeta(path);
    if (!meta?.id || meta.source !== "cli" || normalize(meta.cwd) !== normalize(worktreePath))
      continue;
    if (rolloutHasLaunchMarker(path, codexLaunchMarker(launchId))) ids.add(meta.id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
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
