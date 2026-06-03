// src/branch-pruner.ts
import { execFileSync } from "node:child_process";
import type { SessionStore } from "./store";
import type { GitForge } from "./forge/types";

// Same refname grammar as worktree.ts: rejects a leading "-" so a branch name
// can never smuggle a flag into the `git branch -D` argv.
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Hourly janitor that deletes local `shepherd/*` branches whose PR has merged.
 *
 * The merge train squash-merges (`gh pr merge --squash --delete-branch`), which
 * deletes the remote branch but leaves the local branch's tip a non-ancestor of
 * main — so `WorktreeMgr.pruneMergedBranch`'s `--is-ancestor` check never fires
 * and the branch lingers forever (worse: at merge time the session still holds
 * the worktree, so nothing could delete it then anyway). This sweep is the
 * deferred cleanup: it asks the forge whether each branch's PR merged, which is
 * authoritative regardless of merge method.
 *
 * Orphan branches only — a branch checked out in any worktree, or owned by an
 * active session, is never touched; nor is a branch whose PR isn't `merged`
 * (open/closed/none, or a forge/`gh` error, all mean "keep").
 */
export class BranchPruner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private store: Pick<SessionStore, "list" | "getSetting">,
    private resolveForge: (repoPath: string) => GitForge | null,
    private intervalMs = 60 * 60 * 1000,
    /** Max forge lookups per sweep. Each `forge.prStatus` is a blocking
     *  `execFileSync("gh")` (see github.ts), so an unbounded first sweep over a
     *  large accumulated backlog would stall the event loop; capping bounds the
     *  blocking and lets the backlog drain across subsequent hourly ticks. */
    private maxChecksPerTick = 20,
  ) {}

  /** Default ON: only an explicit "0" disables the sweep. */
  private enabled(): boolean {
    return this.store.getSetting("branchPruneEnabled") !== "0";
  }

  /** Local `shepherd/*` branch short-names in `repo`, or [] on any git error. */
  private shepherdBranches(repo: string): string[] {
    try {
      return execFileSync(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/shepherd/"],
        { cwd: repo, stdio: "pipe" },
      )
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Branch short-names checked out in any worktree of `repo` (can't be -D'd). */
  private checkedOut(repo: string): Set<string> {
    const out = new Set<string>();
    try {
      const txt = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repo,
        stdio: "pipe",
      }).toString();
      const prefix = "branch refs/heads/";
      for (const line of txt.split("\n")) {
        if (line.startsWith(prefix)) out.add(line.slice(prefix.length).trim());
      }
    } catch {
      /* best-effort: empty set; git's own -D refusal is the backstop */
    }
    return out;
  }

  /** Delete a local branch. Returns true iff the delete succeeded. */
  private deleteBranch(repo: string, branch: string): boolean {
    if (!BRANCH_RE.test(branch)) return false;
    try {
      execFileSync("git", ["branch", "-D", branch], { cwd: repo, stdio: "pipe" });
      return true;
    } catch {
      return false; // checked out elsewhere / already gone — best-effort
    }
  }

  /** One forge lookup, never throwing: "merged", "kept" (open/closed/none), or
   *  "error" (gh/forge failure → caller keeps the branch and logs). Kept as its
   *  own method so the loop in pruneRepo stays shallow (cognitive-complexity gate). */
  private async branchMergeState(
    forge: GitForge,
    branch: string,
  ): Promise<"merged" | "kept" | "error"> {
    try {
      return (await forge.prStatus(branch)).state === "merged" ? "merged" : "kept";
    } catch {
      return "error";
    }
  }

  /**
   * Prune merged shepherd branches for a single repo, making at most `budget`
   * forge lookups (each is a blocking `gh` call). Returns the number of lookups
   * actually spent so tick() can keep the per-sweep total bounded.
   */
  private async pruneRepo(
    repo: string,
    activeBranches: Set<string>,
    budget: number,
  ): Promise<number> {
    const forge = this.resolveForge(repo);
    if (!forge) return 0; // can't confirm merged → leave the repo alone
    const checkedOut = this.checkedOut(repo);
    let checks = 0;
    let failures = 0;
    let pruned = false;
    for (const branch of this.shepherdBranches(repo)) {
      if (checkedOut.has(branch) || activeBranches.has(branch)) continue;
      if (checks >= budget) break; // out of budget → leave the rest for the next sweep
      checks++;
      const state = await this.branchMergeState(forge, branch);
      if (state === "error") failures++;
      else if (state === "merged") pruned = this.deleteBranch(repo, branch) || pruned;
    }
    // A persistent gh/forge failure (auth expiry, rate limit) would otherwise leave
    // branches un-pruned with no signal — surface it once per repo per sweep.
    if (failures > 0) {
      console.warn(`[prune] ${failures} forge check(s) failed in ${repo}; kept for next sweep`);
    }
    if (pruned) {
      try {
        execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "pipe" });
      } catch {
        /* best-effort */
      }
    }
    return checks;
  }

  async tick(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      // Repos Shepherd has used (including archived sessions), de-duped — we only
      // ever look at `shepherd/*` branches, which Shepherd itself created.
      const repos = [...new Set(this.store.list().map((s) => s.repoPath))];
      // Branches of live sessions are off-limits regardless of merge state.
      const activeBranches = new Set(
        this.store
          .list({ activeOnly: true })
          .map((s) => s.branch)
          .filter((b): b is string => !!b),
      );
      // Spend a bounded forge-lookup budget across repos so the first post-boot
      // sweep over an accumulated backlog can't stall the event loop.
      let budget = this.maxChecksPerTick;
      for (const repo of repos) {
        if (budget <= 0) break;
        budget -= await this.pruneRepo(repo, activeBranches, budget);
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
