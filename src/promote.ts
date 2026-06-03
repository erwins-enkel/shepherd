import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionStore } from "./store";
import type { WorktreeMgr } from "./worktree";
import type { GitForge } from "./forge/types";
import type { Learning } from "./types";

const execFileP = promisify(execFile);

/** Async git runner — keeps the single-process event loop unblocked during the
 *  fetch/commit/push (house rule: no blocking subprocess in request handlers). */
async function defaultGit(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

export interface PromoterDeps {
  store: Pick<SessionStore, "getLearning" | "listLearnings" | "promoteLearning">;
  worktree: Pick<WorktreeMgr, "create" | "remove">;
  resolveForge: (repoPath: string) => GitForge | null;
  git?: (cwd: string, args: string[]) => Promise<void>;
  /** Injectable CLAUDE.md IO (default: node fs at <worktree>/CLAUDE.md). */
  readClaudeMd?: (path: string) => string;
  writeClaudeMd?: (path: string, content: string) => void;
}

export type PromoteResult =
  | { ok: true; url: string }
  | { ok: false; error: string; status: number };

export class Promoter {
  private git: (cwd: string, args: string[]) => Promise<void>;
  private readClaudeMd: (path: string) => string;
  private writeClaudeMd: (path: string, content: string) => void;
  /** Learning ids with a promote in flight — guards against a double-click firing
   *  two PRs (the second would race the first's `active → promoted` transition). */
  private inflight = new Set<string>();

  constructor(private deps: PromoterDeps) {
    this.git = deps.git ?? defaultGit;
    this.readClaudeMd =
      deps.readClaudeMd ?? ((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
    this.writeClaudeMd = deps.writeClaudeMd ?? ((p, c) => writeFileSync(p, c));
  }

  async promote(id: string): Promise<PromoteResult> {
    // Claim the in-flight slot synchronously, before any await, so a second click
    // landing mid-promote is rejected rather than racing the status transition.
    if (this.inflight.has(id)) {
      return { ok: false, error: "promote already in progress", status: 409 };
    }
    this.inflight.add(id);
    try {
      return await this.run(id);
    } finally {
      this.inflight.delete(id);
    }
  }

  private async run(id: string): Promise<PromoteResult> {
    const learning = this.deps.store.getLearning(id);
    if (!learning) return { ok: false, error: "not found", status: 404 };
    if (learning.status !== "active") {
      return { ok: false, error: "only active rules can be promoted", status: 409 };
    }
    const forge = this.deps.resolveForge(learning.repoPath);
    if (!forge) return { ok: false, error: "no forge configured for repo", status: 400 };

    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      return { ok: false, error: "could not resolve default branch", status: 502 };
    }
    try {
      await this.git(learning.repoPath, ["fetch", "origin", "--", base]);
    } catch {
      /* offline / no origin — fall back to the local base ref */
    }

    // Unique per-attempt branch: a partial failure (push ok but PR url missing → 502)
    // must not wedge a retry on a stale branch name / non-fast-forward push.
    const name = `learnings-promote-${id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const wt = this.deps.worktree.create(learning.repoPath, `origin/${base}`, name);
    if (!wt.isolated || !wt.branch) {
      if (wt.worktreePath !== learning.repoPath) this.deps.worktree.remove(wt.worktreePath);
      return { ok: false, error: "worktree creation failed", status: 500 };
    }
    try {
      return await this.commitAndOpen(forge, learning, base, wt.worktreePath, wt.branch);
    } catch (err) {
      // Don't leak raw git stderr to the client; log it server-side.
      console.warn(`[promote] failed for ${id}:`, err);
      return { ok: false, error: "promote failed", status: 500 };
    } finally {
      await this.cleanup(learning.repoPath, wt.worktreePath, wt.branch);
    }
  }

  /** Tear down the throwaway worktree and force-delete its local branch. The pushed
   *  remote branch backs any opened PR; the local copy is disposable, so leaving it
   *  would just accumulate `shepherd/learnings-promote-*` branches. Best-effort. */
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
    learning: Learning,
    base: string,
    worktreePath: string,
    branch: string,
  ): Promise<PromoteResult> {
    const claudePath = join(worktreePath, "CLAUDE.md");
    const promoted = this.deps.store
      .listLearnings(learning.repoPath, { status: "promoted" })
      .map((l) => l.rule);
    const rules = [...new Set([...promoted, learning.rule])];
    this.writeClaudeMd(claudePath, upsertLearningsBlock(this.readClaudeMd(claudePath), rules));

    await this.git(worktreePath, ["add", "CLAUDE.md"]);
    await this.git(worktreePath, [
      "commit",
      "-m",
      "chore(learnings): promote house rule to CLAUDE.md",
    ]);
    await this.git(worktreePath, ["push", "-u", "origin", branch]);

    const status = await forge.openPr({
      head: branch,
      base,
      title: "chore(learnings): promote curated house rule",
      body: `Promoting a Shepherd-curated house rule into CLAUDE.md:\n\n> ${learning.rule}\n\n${learning.rationale ?? ""}`.trim(),
    });
    if (!status.url) return { ok: false, error: "PR opened but no url returned", status: 502 };
    this.deps.store.promoteLearning(learning.id, status.url);
    return { ok: true, url: status.url };
  }
}

export const LEARNINGS_START = "<!-- shepherd:learnings:start -->";
export const LEARNINGS_END = "<!-- shepherd:learnings:end -->";

/** Insert or replace the managed shepherd:learnings block in CLAUDE.md content.
 *  Idempotent: replaces the existing block's contents rather than appending a
 *  duplicate; appends a fresh block when no markers are present. Each rule is one
 *  `- <rule>` bullet. */
export function upsertLearningsBlock(content: string, rules: string[]): string {
  const body = [LEARNINGS_START, ...rules.map((r) => `- ${r}`), LEARNINGS_END].join("\n");
  const start = content.indexOf(LEARNINGS_START);
  const end = content.indexOf(LEARNINGS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + body + content.slice(end + LEARNINGS_END.length);
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + body + "\n";
}
