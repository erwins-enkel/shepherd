// The source state a heavy-check slot job ran against (#3554): the commit plus a hash of the dirty
// worktree. A result is only trustworthy while the worktree still matches it.
import { createHash } from "node:crypto";
import { constants, open } from "node:fs/promises";
import { join } from "node:path";
import { execGit, type GitPin, resolveWorktreePin } from "./safe-git";

/** Untracked files above this size are hashed by path + size + mtime instead of by content. */
const CONTENT_HASH_MAX_BYTES = 1024 * 1024;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface HeavySlotRevision {
  /** `git rev-parse HEAD`; null when git could not tell (not a repository, unborn branch). */
  head: string | null;
  /** Hash of the uncommitted state; identical for any two clean checkouts of the same HEAD. */
  treeHash: string;
}

async function git(cwd: string, pin: GitPin | null, args: string[]): Promise<string> {
  const { stdout } = await execGit(args, { cwd, pin, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

async function untrackedFingerprint(cwd: string, rel: string): Promise<string> {
  try {
    const path = join(cwd, rel);
    // A symlink may target a FIFO; opening must not block before fstat can reject it.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const st = await file.stat();
      if (!st.isFile()) return `${rel}\0dir`;
      if (st.size > CONTENT_HASH_MAX_BYTES) return `${rel}\0${st.size}\0${st.mtimeMs}`;
      return `${rel}\0${createHash("sha1")
        .update(await file.readFile())
        .digest("hex")}`;
    } finally {
      await file.close();
    }
  } catch {
    return `${rel}\0gone`;
  }
}

/** `repoPath` is the trusted repository the worktree belongs to: the agent owns the worktree's
 *  `.git`, so git runs pinned to the admin dir resolved from the repo (safe-git). */
export async function captureRevision(
  worktreePath: string,
  repoPath: string,
): Promise<HeavySlotRevision> {
  const hash = createHash("sha1");
  try {
    const pin = await resolveWorktreePin(repoPath, worktreePath);
    const head = (await git(worktreePath, pin, ["rev-parse", "HEAD"])).trim() || null;
    hash.update(await git(worktreePath, pin, ["diff", "HEAD", "--no-ext-diff", "--binary"]));
    const untracked = (
      await git(worktreePath, pin, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    for (const rel of untracked) hash.update(await untrackedFingerprint(worktreePath, rel));
    return { head, treeHash: hash.digest("hex") };
  } catch {
    return { head: null, treeHash: hash.digest("hex") };
  }
}

/** Stale unless both sides are known and identical — an unknown revision is never "current". */
export function isStale(stored: HeavySlotRevision, current: HeavySlotRevision): boolean {
  if (stored.head === null || current.head === null) return true;
  return stored.head !== current.head || stored.treeHash !== current.treeHash;
}
