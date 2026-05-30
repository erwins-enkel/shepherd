import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";

export interface WorktreeResult {
  worktreePath: string;
  branch: string | null;
  isolated: boolean;
}

export class WorktreeMgr {
  private isGit(repoPath: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  create(repoPath: string, baseBranch: string, name: string): WorktreeResult {
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) {
      throw new Error("invalid baseBranch");
    }
    if (!this.isGit(repoPath)) {
      return { worktreePath: repoPath, branch: null, isolated: false };
    }
    const branch = `shepherd/${name}`;
    const parent = join(dirname(repoPath), ".shepherd-worktrees");
    const worktreePath = join(parent, `${basename(repoPath)}-${name}`);
    try {
      mkdirSync(parent, { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, baseBranch], {
        cwd: repoPath,
        stdio: "pipe",
      });
      return { worktreePath, branch, isolated: true };
    } catch {
      return { worktreePath: repoPath, branch: null, isolated: false };
    }
  }

  remove(worktreePath: string, opts?: { branch?: string | null; baseBranch?: string }): void {
    let mainRepo: string | null = null;
    if (existsSync(worktreePath)) {
      try {
        // git worktree remove requires cwd in the main repo; find it via --git-common-dir
        const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
          cwd: worktreePath,
          stdio: "pipe",
        })
          .toString()
          .trim();
        // --git-common-dir may be relative to the worktree; resolve before taking its parent
        mainRepo = dirname(resolve(worktreePath, gitCommonDir));
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: mainRepo,
          stdio: "pipe",
        });
      } catch {
        /* git refused (locked/edge/not-a-worktree); fall through to filesystem cleanup */
      }
    }
    // guarantee the workspace is gone even if `git worktree remove` failed or was skipped
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    if (mainRepo) {
      // drop any stale worktree registration left behind
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: mainRepo, stdio: "pipe" });
      } catch {
        /* best-effort */
      }
      // delete the branch only once it's merged into its base; keep unmerged work
      if (opts?.branch && opts.baseBranch) {
        this.pruneMergedBranch(mainRepo, opts.branch, opts.baseBranch);
      }
    }
  }

  /** Delete `branch` iff it is fully merged into `baseBranch`; otherwise retain it. */
  private pruneMergedBranch(mainRepo: string, branch: string, baseBranch: string): void {
    try {
      // exits 0 when branch's tip is an ancestor of base (i.e. nothing would be lost)
      execFileSync("git", ["merge-base", "--is-ancestor", branch, baseBranch], {
        cwd: mainRepo,
        stdio: "pipe",
      });
    } catch {
      return; // unmerged (or check failed) → keep the branch and its commits
    }
    try {
      execFileSync("git", ["branch", "-D", branch], { cwd: mainRepo, stdio: "pipe" });
    } catch {
      /* best-effort */
    }
  }
}
