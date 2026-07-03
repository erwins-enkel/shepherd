import { listDir, resolveFileInRoot, type BrowseListing } from "./fs-browse";

/** Hide `.git` at any level — matches by NAME, so it covers the normal dir, the
 *  `git worktree add` gitdir-pointer FILE, and nested submodule `.git` dirs alike. */
const hideGit = (seg: string): boolean => seg === ".git";

/**
 * List one directory of a session's worktree (read-only). `.git` is hidden; symlinks that
 * resolve outside the worktree are surfaced as non-navigable `linkOutside` entries rather than
 * dropped, so the tree isn't misleadingly incomplete. Returns null on escape/missing/not-a-dir.
 */
export function listWorktree(worktreePath: string, relPath: string): Promise<BrowseListing | null> {
  if (!worktreePath) return Promise.resolve(null); // guard: never fall back to realpath(".")
  return listDir(worktreePath, relPath, { hideSegment: hideGit, onEscape: "mark" });
}

/**
 * Resolve a worktree path that must be a regular FILE for download. Rejects `.git` traversal,
 * root escapes (`..`, absolute), and symlinks resolving outside the worktree. Returns the
 * canonical absolute path or null.
 */
export function resolveWorktreeFile(worktreePath: string, relPath: string): Promise<string | null> {
  if (!worktreePath) return Promise.resolve(null);
  return resolveFileInRoot(worktreePath, relPath, { hideSegment: hideGit });
}
