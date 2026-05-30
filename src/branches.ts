import { execFileSync } from "node:child_process";

export interface BranchList {
  branches: string[];
  current: string | null;
}

/**
 * Local branches of a git repo, most-recently-committed first, plus the current branch.
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
    return { branches: [], current: null };
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
  return { branches, current };
}
