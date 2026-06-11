import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeMgr, WorktreeResult } from "./worktree";
import type { GitForge } from "./forge/types";
import { upsertShepherdIgnoreBlock } from "./shepherd-exclude";

const execFileP = promisify(execFile);

/** Async git runner — keeps the single-process event loop unblocked during the
 *  fetch/commit/push (house rule: no blocking subprocess in request handlers). */
async function defaultGit(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

export interface GitignoreAdopterDeps {
  worktree: Pick<WorktreeMgr, "create" | "remove">;
  resolveForge: (repoPath: string) => GitForge | null;
  git?: (cwd: string, args: string[]) => Promise<void>;
}

export type AdoptResult =
  | { ok: true; status: "applied"; url: string }
  | { ok: true; status: "already" }
  // Expected non-error outcomes (a PR can't be opened, but the local
  // `.git/info/exclude` already hides the artifacts): the caller shows an info
  // toast, never a retryable failure. `no-forge` = no git forge configured for
  // the repo; `no-access` = a forge exists but we lack push permission.
  | { ok: false; reason: "no-forge" | "no-access" }
  | { ok: false; error: string; status: number };

/**
 * Opens a dedicated PR that adds Shepherd's managed `.shepherd-*` ignore block to
 * a repo's committed `.gitignore`. The committed counterpart to
 * `ensureShepherdExclude` (which writes the LOCAL-ONLY `.git/info/exclude`): use
 * this for a repo we can push to, so teammates + CI also ignore Shepherd artifacts.
 *
 * Modelled closely on `Promoter` in `src/promote.ts` — same throwaway-worktree +
 * commit + push + openPr flow, in-flight guard, and generic-500 error masking.
 */
export class GitignoreAdopter {
  private git: (cwd: string, args: string[]) => Promise<void>;
  /** repoPaths with an adopt in flight — guards a double-click from firing two PRs. */
  private inflight = new Set<string>();

  constructor(private deps: GitignoreAdopterDeps) {
    this.git = deps.git ?? defaultGit;
  }

  async adopt(repoPath: string): Promise<AdoptResult> {
    // Claim the in-flight slot synchronously, before any await, so a second click
    // landing mid-adopt is rejected rather than racing the first's PR.
    if (this.inflight.has(repoPath)) {
      return { ok: false, error: "adopt already in progress", status: 409 };
    }
    this.inflight.add(repoPath);
    try {
      return await this.run(repoPath);
    } finally {
      this.inflight.delete(repoPath);
    }
  }

  private async run(repoPath: string): Promise<AdoptResult> {
    // No forge / no push access are NOT errors — a committed .gitignore PR is
    // simply unavailable here, and the local exclude already hides the artifacts.
    // The caller shows an info toast, not a retryable failure.
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return { ok: false, reason: "no-forge" };

    const can = forge.canPush ? await forge.canPush() : false;
    if (!can) return { ok: false, reason: "no-access" };

    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      return { ok: false, error: "could not resolve default branch", status: 502 };
    }
    try {
      await this.git(repoPath, ["fetch", "origin", "--", base]);
    } catch {
      /* offline / no origin — createAdoptWorktree falls back to the local base ref */
    }

    // Unique per-attempt branch: a partial failure (push ok but PR url missing → 502)
    // must not wedge a retry on a stale branch name / non-fast-forward push.
    const name = `adopt-gitignore-${randomUUID().slice(0, 8)}`;
    const wt = this.createAdoptWorktree(repoPath, base, name);
    if (!wt.isolated || !wt.branch) {
      if (wt.worktreePath !== repoPath) this.deps.worktree.remove(wt.worktreePath);
      return { ok: false, error: "worktree creation failed", status: 500 };
    }
    try {
      return await this.commitAndOpen(forge, base, wt.worktreePath, wt.branch);
    } catch (err) {
      // Don't leak raw git stderr to the client; log it server-side.
      console.warn("[gitignore-adopt] failed for", repoPath, err);
      return { ok: false, error: "adopt failed", status: 500 };
    } finally {
      await this.cleanup(repoPath, wt.worktreePath, wt.branch);
    }
  }

  /** Create the throwaway adopt worktree, preferring the freshly-fetched origin
   *  head (branch hygiene). Falls back to the local base ref when `origin/<base>`
   *  isn't available — offline, or a fresh repo with no remote-tracking ref. */
  private createAdoptWorktree(repoPath: string, base: string, name: string): WorktreeResult {
    const wt = this.deps.worktree.create(repoPath, `origin/${base}`, name);
    if (wt.isolated && wt.branch) return wt;
    return this.deps.worktree.create(repoPath, base, name);
  }

  /** Tear down the throwaway worktree and force-delete its local branch. The pushed
   *  remote branch backs any opened PR; the local copy is disposable. Best-effort. */
  private async cleanup(repoPath: string, worktreePath: string, branch: string): Promise<void> {
    this.deps.worktree.remove(worktreePath);
    try {
      await this.git(repoPath, ["branch", "-D", branch]);
    } catch {
      /* best-effort: a never-committed branch may already be gone */
    }
  }

  private async commitAndOpen(
    forge: GitForge,
    base: string,
    worktreePath: string,
    branch: string,
  ): Promise<AdoptResult> {
    const gitignorePath = join(worktreePath, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const { content, changed } = upsertShepherdIgnoreBlock(existing);

    // The block is already in the default branch's .gitignore — nothing to do. This is
    // the post-merge re-click guard: once a prior adopt PR has merged, a fresh worktree
    // off the base already carries the block, so we return "already" with NO new PR.
    // (A deliberate re-click while a prior adopt PR is still OPEN — block not yet on the
    // base — would open a second PR. Acceptable for an explicit, infrequent action; we
    // deliberately do NOT engineer open-PR de-duplication here.)
    if (!changed) return { ok: true, status: "already" };

    writeFileSync(gitignorePath, content);
    await this.git(worktreePath, ["add", ".gitignore"]);
    await this.git(worktreePath, [
      "commit",
      "-m",
      "chore(shepherd): ignore Shepherd session artifacts",
    ]);
    await this.git(worktreePath, ["push", "-u", "origin", branch]);

    const status = await forge.openPr({
      head: branch,
      base,
      title: "chore(shepherd): ignore Shepherd session artifacts",
      body: "Adds Shepherd's managed `.shepherd-*` ignore block to `.gitignore`, so each clone, teammate, and CI run ignores Shepherd's per-session artifacts instead of seeing them as untracked changes.",
    });
    if (!status.url) return { ok: false, error: "PR opened but no url returned", status: 502 };
    return { ok: true, status: "applied", url: status.url };
  }
}
