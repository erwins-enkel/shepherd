import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { resolveInRoot } from "./fs-browse";
import { resolveHostFile, type HostLookup } from "./host-file";
import { existingScratchpadDir, sandboxScratchpadDest } from "./tmp-sweep";

/** Where a host path lives in a session's Files tab (#3997). Mirrors the UI's `FileTarget`. */
export interface FileTarget {
  source: "scratchpad" | "worktree" | "host";
  /** Relative to the source root, forward slashes ("" = the root itself); for `host`, the
   *  absolute host path of a file the session reported (#4017, src/host-file.ts). */
  path: string;
  type: "file" | "dir";
}

const hideGit = (seg: string): boolean => seg === ".git";

/** `p` relative to `root` when it is the root or lies under it (purely lexical), else null. */
function lexicalRel(p: string, root: string): string | null {
  const r = normalize(root);
  if (p === r) return "";
  return p.startsWith(r.endsWith(sep) ? r : r + sep) ? relative(r, p) : null;
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/** The first alias of `root` that lexically contains `p`, as a root-relative path. */
function relUnder(p: string, aliases: string[]): string | null {
  for (const a of aliases) {
    const rel = lexicalRel(p, a);
    if (rel !== null) return rel;
  }
  return null;
}

async function targetIn(
  source: FileTarget["source"],
  root: string,
  rel: string,
): Promise<FileTarget | null> {
  const hit = await resolveInRoot(root, rel, source === "worktree" ? { hideSegment: hideGit } : {});
  if (!hit) return null;
  const st = await fsp.stat(hit.resolved).catch(() => null);
  if (!st || !(st.isFile() || st.isDirectory())) return null;
  return {
    source,
    path: relative(hit.rootReal, hit.resolved).split(sep).join("/"),
    type: st.isDirectory() ? "dir" : "file",
  };
}

/**
 * Map a host path an agent linked (absolute, or `~/…`) to the session's scratchpad or worktree,
 * so the chat can open it in the Files tab (#3997). Answers only containment questions about the
 * two roots the operator can already browse: a path is first matched LEXICALLY against each root
 * (plus its realpath and, for the scratchpad, the path a sandboxed agent sees), so a path outside
 * both never touches the filesystem. Inside a root, `resolveInRoot` enforces realpath containment
 * (symlink escapes → null) and the worktree hides `.git`. With `host`, a path outside both roots
 * may still resolve to a read-only `host` target when the session itself reported it and it
 * passes every guard in src/host-file.ts (#4017). Null when nothing matches.
 */
export async function locateSessionFile(
  worktreePath: string,
  claudeSessionId: string,
  rawPath: string,
  host?: HostLookup,
): Promise<FileTarget | null> {
  if (!rawPath || rawPath.includes("\0")) return null;
  const expanded = rawPath.startsWith("~/")
    ? (process.env.HOME || homedir()) + rawPath.slice(1)
    : rawPath;
  if (!isAbsolute(expanded)) return null;
  const p = normalize(expanded);

  if (claudeSessionId) {
    const root = await existingScratchpadDir(worktreePath, claudeSessionId);
    const aliases = [
      root,
      await realOrSelf(root),
      sandboxScratchpadDest(worktreePath, claudeSessionId),
    ];
    const rel = relUnder(p, aliases);
    if (rel !== null) return targetIn("scratchpad", root, rel);
  }
  if (worktreePath) {
    const rel = relUnder(p, [worktreePath, await realOrSelf(worktreePath)]);
    if (rel !== null) return targetIn("worktree", worktreePath, rel);
  }
  if (!host) return null;
  const hit = await resolveHostFile(rawPath, host);
  return hit ? { source: "host", path: hit.path, type: "file" } : null;
}
