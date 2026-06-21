import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SessionStore } from "./store";
import type { WorktreeMgr, WorktreeResult } from "./worktree";
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
    // Ensure the parent dir exists before writing — harmless for worktree paths (the dir is
    // already there), and lets the global write (issue #872) create ~/.claude if absent.
    this.writeClaudeMd =
      deps.writeClaudeMd ??
      ((p, c) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c);
      });
  }

  /** Write a single cross-repo rule into the user-global `~/.claude/CLAUDE.md` (issue #872).
   *  No forge/branch/PR — a direct, operator-confirmed write to the home-dir file. Reads the
   *  existing Shepherd-owned block, unions the rule in (dedup, order-preserving) and rewrites.
   *  Idempotent: a no-op (no write) when the rule is already present. `homedir()` is the server
   *  process's home — see the issue's home-dir-trust caveat. */
  async promoteGlobal(rule: string): Promise<PromoteResult> {
    const path = join(homedir(), ".claude", "CLAUDE.md");
    try {
      const current = this.readClaudeMd(path);
      const rules = [...new Set([...extractLearningsBlockRules(current), rule])];
      const next = upsertLearningsBlock(current, rules);
      if (next === current) return { ok: true, url: "" };
      this.writeClaudeMd(path, next);
      return { ok: true, url: "" };
    } catch (err) {
      // Don't leak raw fs stderr (EACCES/EROFS on the home dir) to the client; log it
      // server-side and return a structured result, matching the PR-promote path.
      console.warn(`[promote-global] failed:`, err);
      return { ok: false, error: "global promote failed", status: 500 };
    }
  }

  async resyncPromoted(repoPath: string): Promise<PromoteResult> {
    // Claim inflight slot synchronously — repo path can't collide with a learning id.
    if (this.inflight.has(repoPath)) {
      return { ok: false, error: "resync already in progress", status: 409 };
    }
    this.inflight.add(repoPath);
    try {
      const promoted = this.deps.store.listLearnings(repoPath, { status: "promoted" });
      // Empty block sync is a no-op: nothing to write and git commit would error on empty diff.
      if (promoted.length === 0) return { ok: true, url: "" };

      const forge = this.deps.resolveForge(repoPath);
      if (!forge) return { ok: false, error: "no forge configured for repo", status: 400 };
      // Local-commit promotion is a deferred follow-up (#807 out-of-scope v1).
      if (forge.kind === "local") {
        return {
          ok: false,
          error: "learnings promotion is not available in lightweight repo mode",
          status: 400,
        };
      }

      let base: string;
      try {
        base = await forge.defaultBranch();
      } catch {
        return { ok: false, error: "could not resolve default branch", status: 502 };
      }
      try {
        await this.git(repoPath, ["fetch", "origin", "--", base]);
      } catch {
        /* offline / no origin — createPromoteWorktree falls back to the local base ref */
      }

      const name = `learnings-resync-${randomUUID().slice(0, 8)}`;
      const wt = this.createPromoteWorktree(repoPath, base, name);
      if (!wt.isolated || !wt.branch) {
        if (wt.worktreePath !== repoPath) this.deps.worktree.remove(wt.worktreePath);
        return { ok: false, error: "worktree creation failed", status: 500 };
      }
      try {
        const rules = [...new Set(promoted.map((l) => l.rule))];
        const claudePath = join(wt.worktreePath, "CLAUDE.md");
        const current = this.readClaudeMd(claudePath);
        const next = upsertLearningsBlock(current, rules);
        // Content-compare guard: skip commit/push/PR if block is already current.
        // Avoids a spurious git-commit error on an empty diff.
        if (next === current) return { ok: true, url: "" };

        this.writeClaudeMd(claudePath, next);
        await this.git(wt.worktreePath, ["add", "CLAUDE.md"]);
        await this.git(wt.worktreePath, [
          "commit",
          "-m",
          "chore(learnings): sync optimized house rule to CLAUDE.md",
        ]);
        await this.git(wt.worktreePath, ["push", "-u", "origin", wt.branch]);

        const body = [
          "Syncing optimized Shepherd house rules into CLAUDE.md:\n",
          ...rules.map((r) => `> ${r}`),
        ].join("\n");
        const status = await forge.openPr({
          head: wt.branch,
          base,
          title: "chore(learnings): sync optimized house rules",
          body,
        });
        if (!status.url) return { ok: false, error: "PR opened but no url returned", status: 502 };
        return { ok: true, url: status.url };
      } catch (err) {
        console.warn(`[resync] failed for ${repoPath}:`, err);
        return { ok: false, error: "resync failed", status: 500 };
      } finally {
        await this.cleanup(repoPath, wt.worktreePath, wt.branch);
      }
    } finally {
      this.inflight.delete(repoPath);
    }
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
    // Local-commit promotion is a deferred follow-up (#807 out-of-scope v1).
    if (forge.kind === "local") {
      return {
        ok: false,
        error: "learnings promotion is not available in lightweight repo mode",
        status: 400,
      };
    }

    let base: string;
    try {
      base = await forge.defaultBranch();
    } catch {
      return { ok: false, error: "could not resolve default branch", status: 502 };
    }
    try {
      await this.git(learning.repoPath, ["fetch", "origin", "--", base]);
    } catch {
      /* offline / no origin — createPromoteWorktree falls back to the local base ref */
    }

    // Unique per-attempt branch: a partial failure (push ok but PR url missing → 502)
    // must not wedge a retry on a stale branch name / non-fast-forward push.
    const name = `learnings-promote-${id.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    let wt: WorktreeResult;
    try {
      wt = this.createPromoteWorktree(learning.repoPath, base, name);
    } catch (err) {
      console.warn(`[promote] worktree isolation failed for ${id}:`, err);
      return { ok: false, error: "worktree creation failed", status: 500 };
    }
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

  /** Create the throwaway promote worktree, preferring the freshly-fetched origin
   *  head (branch hygiene). Falls back to the local base ref when `origin/<base>`
   *  isn't available — offline, or a fresh repo with no remote-tracking ref — so an
   *  unreachable remote degrades to a local-base PR rather than an opaque 500. */
  private createPromoteWorktree(repoPath: string, base: string, name: string): WorktreeResult {
    try {
      return this.deps.worktree.create(repoPath, `origin/${base}`, name);
    } catch {
      return this.deps.worktree.create(repoPath, base, name);
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

/** Normalize a free-form learning rule into a single Markdown list-item body that is
 *  byte-for-byte stable under `prettier --check` (CommonMark). Target repos lint their
 *  CLAUDE.md with prettier; an un-normalized rule could otherwise reparse as a nested
 *  list / heading or get whitespace-collapsed, re-flagging the synced block (flowagent #418).
 *  - collapses every whitespace run (incl. tabs/newlines) to a single space and trims ends
 *  - backslash-escapes a leading Markdown list/heading marker so prettier keeps it as text
 *    (a backslash-escaped marker renders identically). Idempotent. */
export function sanitizeRule(rule: string): string {
  return rule
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^([-*+]) /, "\\$1 ")
    .replace(/^(\d+)([.)]) /, "$1\\$2 ")
    .replace(/^(#+) /, "\\$1 ");
}

/** Insert or replace the managed shepherd:learnings block in CLAUDE.md content.
 *  Idempotent: replaces the existing block's contents rather than appending a
 *  duplicate; appends a fresh block when no markers are present. Each rule is one
 *  `- <rule>` bullet. A blank line follows the start marker — prettier/CommonMark
 *  requires it between an HTML-comment block and the list, else `prettier --check`
 *  fails in target repos (flowagent #418). Each rule is sanitized for the same reason. */
export function upsertLearningsBlock(content: string, rules: string[]): string {
  const body = [
    LEARNINGS_START,
    "",
    ...rules.map((r) => `- ${sanitizeRule(r)}`),
    LEARNINGS_END,
  ].join("\n");
  const start = content.indexOf(LEARNINGS_START);
  const end = content.indexOf(LEARNINGS_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + body + content.slice(end + LEARNINGS_END.length);
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + body + "\n";
}

/** Parse the rules out of the managed `shepherd:learnings` block — the inverse of
 *  `upsertLearningsBlock`, used to accumulate across successive global promotes (#872).
 *  Returns `[]` when no block is present. Tolerant of CRLF and leading whitespace; only
 *  `- <rule>` bullets are returned — non-bullet/prose lines inside the block are ignored
 *  (the block is Shepherd-owned and rewritten in full, so hand-edits aren't preserved). */
export function extractLearningsBlockRules(content: string): string[] {
  const start = content.indexOf(LEARNINGS_START);
  const end = content.indexOf(LEARNINGS_END);
  if (start === -1 || end === -1 || end <= start) return [];
  return content
    .slice(start + LEARNINGS_START.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}
