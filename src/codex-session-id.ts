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
 *  - `source === "cli"` excludes headless `codex exec` ROLE spawns (recap/critic/reviewer) that can
 *    share a worktree cwd; resuming one of those instead of the interactive session would be wrong.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { normalize } from "node:path";

import { codexHome, listRolloutFiles } from "./codex-usage";

export interface SessionMetaHeader {
  id: string | null;
  cwd: string;
  source: string | null;
}

/**
 * The newest interactive (`source === "cli"`) rollout whose recorded cwd equals `worktreePath`,
 * among rollouts modified at/after `notBeforeMs`; null if none. The scan is UNBOUNDED over that
 * mtime window (callers must not cap it) so a busy machine can't push the target rollout out of view.
 */
export function findCodexSessionId(
  worktreePath: string,
  notBeforeMs: number,
  home = codexHome(),
): string | null {
  const target = normalize(worktreePath);
  // listRolloutFiles is newest-first by mtime, so the first cwd+cli match is the newest one — and the
  // first file older than the window means every remaining file is too: stop rather than scan the tail.
  for (const { path, mtimeMs } of listRolloutFiles(home)) {
    if (mtimeMs < notBeforeMs) break;
    const meta = readSessionMeta(path);
    if (!meta || meta.source !== "cli" || !meta.id) continue;
    if (normalize(meta.cwd) === target) return meta.id;
  }
  return null;
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
