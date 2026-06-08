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

  /** Whether the branch checked out at `worktreePath` is BEHIND `baseBranch` — i.e.
   *  base has commits not yet in HEAD, so a strict merge train must rebase first.
   *  Best-effort fetches `origin/<base>` and prefers it; falls back to the local
   *  base ref when offline. Returns:
   *    false → base is an ancestor of HEAD (up-to-date, safe to merge)
   *    true  → base has commits HEAD lacks (stale, rebase needed)
   *    null  → unknowable (bad worktree / git error) → caller treats as "do not merge"
   */
  behindBase(worktreePath: string, baseBranch: string): boolean | null {
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) return null;
    try {
      execFileSync("git", ["fetch", "origin", "--", baseBranch], {
        cwd: worktreePath,
        stdio: "pipe",
      });
    } catch {
      /* offline / no origin — compare against whatever base ref is local */
    }
    // Prefer the just-fetched remote ref; fall back to a local base branch.
    const candidates = [`origin/${baseBranch}`, baseBranch];
    for (const ref of candidates) {
      try {
        execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
          cwd: worktreePath,
          stdio: "pipe",
        });
      } catch {
        continue; // ref doesn't exist locally; try the next
      }
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], {
          cwd: worktreePath,
          stdio: "pipe",
        });
        return false; // ref is an ancestor of HEAD → up-to-date
      } catch (err) {
        // exit 1 = "not an ancestor" → genuinely behind; any other exit (e.g. 128,
        // a transient/ref error) is unknowable → null (caller treats as "do not merge").
        if ((err as { status?: number }).status === 1) return true;
        return null;
      }
    }
    return null; // no usable base ref → unknown
  }

  /** Whether `sha` is reachable from the branch tip checked out at `worktreePath`
   *  — i.e. the commit genuinely belongs to this session's branch. Used to reject
   *  a PR that `gh pr list --head <name>` matched purely on branch NAME: a prior,
   *  already-merged PR that reused this branch name reports a head commit that this
   *  freshly-cut branch does not contain. Returns:
   *    true  → `sha` is HEAD or an ancestor of it (this branch's own commit)
   *    false → `sha` is absent locally OR not an ancestor (a foreign / stale PR)
   *    null  → unknowable (bad worktree / git error) → caller keeps the PR as-is
   */
  containsCommit(worktreePath: string, sha: string): boolean | null {
    if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) return null;
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: worktreePath,
        stdio: "pipe",
      });
    } catch {
      return false; // object not in this worktree's store → not our branch's commit
    }
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
        cwd: worktreePath,
        stdio: "pipe",
      });
      return true; // reachable from HEAD → this session's own commit
    } catch (err) {
      // exit 1 = "not an ancestor" → foreign commit; any other exit (e.g. 128, a
      // bad worktree) is unknowable → null (caller leaves the PR untouched).
      if ((err as { status?: number }).status === 1) return false;
      return null;
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
