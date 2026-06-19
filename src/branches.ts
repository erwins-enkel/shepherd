import { execFileSync } from "./instrument";

export interface BranchList {
  branches: string[];
  current: string | null;
  /** Repo default branch (`origin/HEAD` symref, `origin/` stripped); null when unset. */
  default: string | null;
}

/**
 * Local branches of a git repo, most-recently-committed first, plus the current branch and
 * the repo's default branch (the base a new task should prefer).
 * Returns empty list for non-git dirs (caller falls back to a free-text branch field).
 */
export function listBranches(repoDir: string): BranchList {
  let branches: string[];
  try {
    branches = execFileSync(
      "git",
      ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
      { cwd: repoDir, stdio: "pipe" },
    )
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return { branches: [], current: null, default: null };
  }
  let current: string | null = null;
  try {
    current =
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim() || null;
  } catch {
    /* detached HEAD or other — leave null */
  }
  // Repo default branch from the local origin/HEAD symref (no network). Resolved fresh per
  // call — /api/branches is not hot, and a cached value would go stale if origin/HEAD moves.
  let def: string | null = null;
  try {
    def =
      execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        cwd: repoDir,
        stdio: "pipe",
      })
        .toString()
        .trim()
        .replace(/^origin\//, "") || null;
  } catch {
    /* origin/HEAD unset — leave null; caller falls back to current */
  }
  return { branches, current, default: def };
}
