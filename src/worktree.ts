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

  /** True iff a local branch `branch` exists in `repoPath`. Used to pre-empt a
   *  rename collision before touching any remote. */
  branchExists(repoPath: string, branch: string): boolean {
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(branch)) return false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: repoPath,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Rename a local branch. `git branch -m` works even while the branch is checked
   *  out in a worktree, so this is safe to run on a live session's branch. Throws
   *  when the target name is already taken (the caller surfaces that as a conflict). */
  renameBranch(repoPath: string, oldBranch: string, newBranch: string): void {
    for (const b of [oldBranch, newBranch]) {
      if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(b)) throw new Error("invalid branch");
    }
    execFileSync("git", ["branch", "-m", oldBranch, newBranch], { cwd: repoPath, stdio: "pipe" });
  }

  /** The branch currently checked out in `worktreePath`, or null when HEAD is
   *  detached or the path isn't a readable git worktree. This is the source of
   *  truth for which branch a session's PR will come from — an agent that runs
   *  `git checkout -b` / `git branch -m` moves it out from under the stored value. */
  currentBranch(worktreePath: string): string | null {
    try {
      const out = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: worktreePath,
        stdio: "pipe",
        encoding: "utf8",
      });
      return out.trim() || null;
    } catch {
      return null; // detached HEAD or not a worktree
    }
  }

  /** Commits on `branch` not yet on `baseBranch` (`git rev-list --count base..branch`).
   *  0 means the branch tip still equals base — the "nothing committed yet" window in
   *  which an auto-rename can safely move the branch. Returns a large number on any
   *  git error so callers treat an unknowable state as "not safe to rename". */
  commitsAhead(repoPath: string, baseBranch: string, branch: string): number {
    for (const b of [baseBranch, branch]) {
      if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(b)) return Number.MAX_SAFE_INTEGER;
    }
    try {
      const out = execFileSync("git", ["rev-list", "--count", `${baseBranch}..${branch}`], {
        cwd: repoPath,
        stdio: "pipe",
        encoding: "utf8",
      });
      return Number.parseInt(out.trim(), 10) || 0;
    } catch {
      return Number.MAX_SAFE_INTEGER; // unknowable → not safe
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

  /** Detached worktree at a specific commit, fetching it from origin first so a
   *  PR head pushed by the agent is present even when the local repo is behind.
   *  Used by the critic to review the exact PR head. */
  createDetached(repoPath: string, branch: string, sha: string): WorktreeResult {
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw new Error("invalid sha");
    // same refname grammar as create(); rejecting a leading "-" also blocks argv
    // flag-smuggling into the `git fetch` below (the `--` is belt-and-suspenders)
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(branch)) throw new Error("invalid branch");
    const parent = join(dirname(repoPath), ".shepherd-worktrees");
    const worktreePath = join(parent, `${basename(repoPath)}-review-${sha.slice(0, 8)}`);
    mkdirSync(parent, { recursive: true });
    try {
      // best-effort: pull the PR head into the local object store (no-op if local)
      execFileSync("git", ["fetch", "origin", "--", branch], { cwd: repoPath, stdio: "pipe" });
    } catch {
      /* offline / no origin — the sha may already be local; let worktree add decide */
    }
    // A prior critic run interrupted by a restart can leave this path behind;
    // reclaim it (git worktree remove + fs cleanup) so a re-spawned review for
    // the same head isn't permanently blocked by `worktree add` hitting an
    // occupied directory.
    if (existsSync(worktreePath)) this.remove(worktreePath);
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, sha], {
      cwd: repoPath,
      stdio: "pipe",
    });
    return { worktreePath, branch: null, isolated: true };
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
