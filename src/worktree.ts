import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";

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

  remove(worktreePath: string): void {
    if (!existsSync(worktreePath)) return;
    try {
      // git worktree remove requires cwd in the main repo; find it via --git-common-dir
      const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: worktreePath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      const mainRepo = dirname(gitCommonDir);
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: mainRepo,
        stdio: "pipe",
      });
    } catch {
      /* leave on disk; branch retained per spec */
    }
  }
}
