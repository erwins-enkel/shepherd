import { execFile } from "node:child_process";
import { execFileSync } from "./instrument";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { promisify } from "node:util";
import { timedAsync } from "./instrument";
import { ensureShepherdExclude } from "./shepherd-exclude";
import { removeWorktreeScratch } from "./tmp-sweep";

const execFileAsync = promisify(execFile);

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
    // Must run before the try so it covers both the worktree-add success path and the
    // catch fallback where the session runs in the main checkout (isolated: false) —
    // the exact case that would drop .shepherd-* artifacts into the operator's tree.
    ensureShepherdExclude(repoPath);
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

  /** Ensure `baseBranch` resolves locally AND is current before a worktree bases on it.
   *  Skips the fetch only for the main clone's checked-out branch (git refuses to fetch into
   *  it; the default branch is normally HEAD, so regular spawns keep basing on the local tip
   *  as before — no new network hit). For any other base (e.g. an epic integration branch that
   *  advances on the remote as siblings merge), `git fetch origin <b>:<b>` creates-or-FFs the
   *  local branch so the worktree bases on the latest tip. Best-effort + async (never sync on
   *  the server loop): a failure warns and the subsequent worktree.create surfaces a real error
   *  if the base is genuinely unresolvable. */
  async ensureBaseRef(repoPath: string, baseBranch: string): Promise<void> {
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) return;
    try {
      const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd: repoPath,
      });
      if (stdout.trim() === baseBranch) return; // checked-out branch — can't/needn't fetch
    } catch {
      // detached HEAD or error — fall through and attempt the fetch
    }
    try {
      await execFileAsync("git", ["fetch", "origin", `${baseBranch}:${baseBranch}`], {
        cwd: repoPath,
      });
    } catch (err) {
      console.warn(`[worktree] ensureBaseRef fetch ${baseBranch} failed:`, err);
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
  async behindBase(worktreePath: string, baseBranch: string): Promise<boolean | null> {
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(baseBranch)) return null;
    try {
      await timedAsync("git fetch", () =>
        execFileAsync("git", ["fetch", "origin", "--", baseBranch], { cwd: worktreePath }),
      );
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

  /** The ABSOLUTE shared git object store for `worktreePath` (`git rev-parse
   *  --git-common-dir`, resolved against the worktree). A worktree's own `.git` is a
   *  file pointing here; the bwrap membrane must bind this store rw so the agent's
   *  git ops reach the real refs/objects. Falls back to `<worktreePath>/.git` on any
   *  git error so a non-worktree (isolated:false) still yields a usable path. */
  gitCommonDir(worktreePath: string): string {
    try {
      const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: worktreePath,
        stdio: "pipe",
        encoding: "utf8",
      });
      return resolve(worktreePath, out.trim());
    } catch {
      return join(worktreePath, ".git");
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
    // best-effort reclamation of the nested claude scratch dir for this worktree;
    // never blocks or fails archival (fire-and-forget, removeWorktreeScratch never throws).
    void removeWorktreeScratch(worktreePath).catch(() => {});
  }

  /** Detached worktree at a specific commit, fetching it from origin first so a
   *  PR head pushed by the agent is present even when the local repo is behind.
   *  Used by the critic to review the exact PR head.
   *
   *  `slug` disambiguates the worktree path when callers do NOT have a unique sha to key
   *  on. The PR critic detaches at the PR head sha (unique per PR), so it omits `slug` and
   *  the path stays `…-review-<sha>` — reused-on-restart to reclaim an interrupted run (the
   *  `existsSync`-reclaim below is load-bearing for that slugless path). The plan reviewer,
   *  however, detaches every session at the SAME base-branch sha, so without a slug all plan
   *  reviews in a repo would collide on one path: a second begin() would blow away the first's
   *  live worktree, and both inflight records would then read the same `.shepherd-plan-review.json`
   *  — delivering one run's plan findings to another. It passes a per-RUN unique id (the reviewer's
   *  pinned session id, a fresh randomUUID per spawn) as `slug`, so the path disambiguates across
   *  RUNS — even two reviews of the SAME session at the SAME sha get distinct paths (#631), not
   *  just two different sessions.
   *
   *  `pullRef` is the OPTIONAL fork escape hatch for the standalone PR critic. A fork PR's head
   *  sha is NOT on the base repo's `origin` (it lives on the contributor's fork), so the `branch`
   *  fetch below can't land it and `worktree add --detach <sha>` would fail with a missing object.
   *  When provided (e.g. `refs/pull/<n>/head`, which GitHub exposes on the base repo's origin) it
   *  is ALSO fetched — same `--`-guarded grammar as the branch fetch — so the head sha reaches the
   *  local store before the checkout. Same-repo callers (ReviewService, the plan reviewer) omit it
   *  and behavior is unchanged. */
  async createDetached(
    repoPath: string,
    branch: string,
    sha: string,
    slug?: string,
    pullRef?: string,
  ): Promise<WorktreeResult> {
    if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) throw new Error("invalid sha");
    // same refname grammar as create(); rejecting a leading "-" also blocks argv
    // flag-smuggling into the `git fetch` below (the `--` is belt-and-suspenders)
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(branch)) throw new Error("invalid branch");
    // A pull ref like `refs/pull/<n>/head` has the same safe refname shape; the leading-"-"
    // rejection + the `--` guard on its fetch block flag-smuggling identically to `branch`.
    if (pullRef !== undefined && !/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(pullRef)) {
      throw new Error("invalid pullRef");
    }
    // flat filesystem-safe token only — no `/` (subdirs) and no `.` (so no `..` traversal);
    // a session UUID satisfies this.
    if (slug !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(slug)) throw new Error("invalid slug");
    const parent = join(dirname(repoPath), ".shepherd-worktrees");
    const tag = slug ? `${slug}-${sha.slice(0, 8)}` : sha.slice(0, 8);
    const worktreePath = join(parent, `${basename(repoPath)}-review-${tag}`);
    mkdirSync(parent, { recursive: true });
    try {
      // best-effort: pull the PR head into the local object store (no-op if local)
      await timedAsync("git fetch", () =>
        execFileAsync("git", ["fetch", "origin", "--", branch], { cwd: repoPath }),
      );
    } catch {
      /* offline / no origin — the sha may already be local; let worktree add decide */
    }
    if (pullRef !== undefined) {
      try {
        // Fork head: the `branch` fetch above can't reach it (the branch lives on the fork, not
        // base origin), so fetch the PR's pull ref too. Best-effort like the branch fetch — a
        // failure just leaves `worktree add` to surface a missing-object error the caller catches.
        await timedAsync("git fetch", () =>
          execFileAsync("git", ["fetch", "origin", "--", pullRef], { cwd: repoPath }),
        );
      } catch {
        /* offline / no origin / ref gone — let worktree add decide */
      }
    }
    // A prior critic run interrupted by a restart can leave this path behind;
    // reclaim it (git worktree remove + fs cleanup) so a re-spawned review for
    // the same head isn't permanently blocked by `worktree add` hitting an
    // occupied directory.
    if (existsSync(worktreePath)) this.remove(worktreePath);
    // `worktree add --detach` is a full working-tree checkout — the heaviest local git op
    // here — and createDetached runs on the plan-gate / critic background-poll path, so run
    // it async to keep the checkout off the Bun event loop. (No stdin constraint, unlike
    // patch-id, so execFileAsync works directly.)
    await timedAsync("git worktree add", () =>
      execFileAsync("git", ["worktree", "add", "--detach", worktreePath, sha], { cwd: repoPath }),
    );
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
