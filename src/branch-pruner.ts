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

  private deleteBranch(repo: string, branch: string): void {
    if (!BRANCH_RE.test(branch)) return;
    try {
      execFileSync("git", ["branch", "-D", branch], { cwd: repo, stdio: "pipe" });
    } catch {
      /* checked out elsewhere / already gone — best-effort */
    }
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
      for (const repo of repos) {
        const forge = this.resolveForge(repo);
        if (!forge) continue; // can't confirm merged → leave the repo alone
        const checkedOut = this.checkedOut(repo);
        let pruned = false;
        for (const branch of this.shepherdBranches(repo)) {
          if (checkedOut.has(branch) || activeBranches.has(branch)) continue;
          let merged = false;
          try {
            merged = (await forge.prStatus(branch)).state === "merged";
          } catch {
            continue; // gh error → unknown → keep
          }
          if (!merged) continue;
          this.deleteBranch(repo, branch);
          pruned = true;
        }
        if (pruned) {
          try {
            execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "pipe" });
          } catch {
            /* best-effort */
          }
        }
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
