import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
   *    null  → unknowable (worktree unusable / git couldn't run) → caller keeps the PR
   *
   *  Two known limitations of the reachability test:
   *  - **Assumes squash/rebase merges** (this repo's policy — merge commits are
   *    disabled). Under those, a merged feature commit is NOT an ancestor of main,
   *    so a reused-name branch cut from main fails to reach the old PR head → the
   *    collision is caught. On a repo using plain *merge commits*, the old PR's
   *    head stays reachable from main, so a fresh same-name branch would still
   *    "own" it and the collision would slip through.
   *  - **Transient false-negative after a self-rebase.** If a session's own PR
   *    merges and the still-active branch is then rebased/reset, the PR head is no
   *    longer an ancestor of HEAD, so a genuine MERGED is dropped to `none`. Rare
   *    (a session usually archives once its PR lands) and self-heals once the PR
   *    head returns to the history; acceptable versus the false-MERGED it prevents.
   */
  containsCommit(worktreePath: string, sha: string): boolean | null {
    if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) return null;
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: worktreePath,
        stdio: "pipe",
      });
    } catch (err) {
      // git ran and reported the object missing (numeric exit) → a clean miss, the
      // commit isn't in this branch's store → false. No exit code means git never
      // ran (e.g. ENOENT on an unusable worktree cwd) → unknowable → null, so the
      // caller doesn't mistake a broken worktree for a foreign PR.
      return typeof (err as { status?: number }).status === "number" ? false : null;
    }
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
        cwd: worktreePath,
        stdio: "pipe",
      });
      return true; // reachable from HEAD → this session's own commit
    } catch (err) {
      // exit 1 = "not an ancestor" → foreign commit; any other exit (e.g. 128) or a
      // spawn failure is unknowable → null (caller leaves the PR untouched).
      return (err as { status?: number }).status === 1 ? false : null;
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
   *  Used by the critic to review the exact PR head and by the plan gate to inspect
   *  the base.
   *
   *  `key` (the owning session id) namespaces the path so two concurrent reviewers
   *  in the SAME repo can't share a worktree — and thus can't read each other's
   *  verdict file. Without it, the path collapsed to `<repo>-review-<sha8>`: two
   *  sessions branched off the same base produced the identical base-sha path, so
   *  one reviewer's verdict was steered into the other's pane (cross-streamed). The
   *  same `key`+`sha` still reclaims a stale path so a session re-spawning its own
   *  review after a restart re-pairs to its tree.
   *
   *  `key` must already be path-safe (`[A-Za-z0-9_-]`); we ASSERT rather than strip
   *  unsafe chars, so distinct keys can never slug to the same path (silent stripping
   *  would map e.g. `s/1` and `s1` onto one tree — reintroducing the cross-stream).
   *  Session ids are uuids, so this never fires in practice; a malformed key fails
   *  closed.
   *
   *  Also sweeps any pre-upgrade legacy-format reviewer worktrees (see
   *  `sweepLegacyReviewWorktrees`) so they don't leak now that the path is keyed. */
  createDetached(repoPath: string, branch: string, sha: string, key: string): WorktreeResult {
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw new Error("invalid sha");
    // same refname grammar as create(); rejecting a leading "-" also blocks argv
    // flag-smuggling into the `git fetch` below (the `--` is belt-and-suspenders)
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(branch)) throw new Error("invalid branch");
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("invalid key");
    const base = basename(repoPath);
    const parent = join(dirname(repoPath), ".shepherd-worktrees");
    const worktreePath = join(parent, `${base}-review-${key}-${sha.slice(0, 8)}`);
    mkdirSync(parent, { recursive: true });
    // Sweep every pre-namespacing `<repo>-review-<sha8>` orphan (any sha, not just
    // this head's). No current code writes that format, so each is a leftover from an
    // interrupted pre-upgrade run; without this they'd leak under .shepherd-worktrees
    // forever, since the new namespaced path never reclaims them.
    this.sweepLegacyReviewWorktrees(parent, base);
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

  /** Remove every pre-namespacing reviewer worktree (`<repo>-review-<sha8>`, with no
   *  session segment) under `parent`. Current code only writes the namespaced form
   *  `<repo>-review-<key>-<sha8>` (whose remainder after the prefix always carries a
   *  `-`, so it never matches the bare-8-hex test below), meaning every match here is
   *  an orphan from an interrupted pre-upgrade run. Best-effort: a missing dir or a
   *  remove that git refuses is tolerated. */
  private sweepLegacyReviewWorktrees(parent: string, base: string): void {
    const prefix = `${base}-review-`;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      return; // parent not present yet → nothing to sweep
    }
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue;
      if (/^[0-9a-fA-F]{8}$/.test(name.slice(prefix.length))) this.remove(join(parent, name));
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
