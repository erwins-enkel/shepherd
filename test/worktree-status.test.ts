import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWorktreeStatus, MAX_UNPUSHED_LISTED } from "../src/worktree-status";

// Explicit env that does NOT inherit ambient GIT_DIR — see test/diff.test.ts.
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" }).toString().trim();

function commit(repo: string, file: string, body: string, msg: string): void {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
}

/** origin (bare) with main@base; clone on `feature` with `ahead` commits. A second clone pushes
 *  `behind` commits to origin/main, so the feature clone's base moves on after it forked. */
function fixture(ahead: number, behind: number): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), "shepherd-wt-status-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  git(repo, "checkout", "-q", "-b", "main");
  commit(repo, "a.txt", "base\n", "base");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "checkout", "-q", "-b", "feature");
  for (let i = 0; i < ahead; i++) commit(repo, `f${i}.txt`, `${i}\n`, `feature ${i}`);
  git(root, "clone", "-q", origin, other);
  for (let i = 0; i < behind; i++) commit(other, `m${i}.txt`, `${i}\n`, `main ${i}`);
  if (behind) git(other, "push", "-q", "origin", "main");
  return { root, repo };
}

test("never-pushed branch: behind/ahead vs fresh origin/main, all ahead commits unpushed", async () => {
  const { root, repo } = fixture(3, 2);
  try {
    const s = await computeWorktreeStatus(repo, "main", "feature");
    expect(s.baseRef).toBe("origin/main");
    expect(s.fetchFailed).toBe(false);
    expect(s.head).toBe("feature");
    expect(s.behindBase).toBe(2);
    expect(s.aheadOfBase).toBe(3);
    expect(s.upstream).toBeNull();
    expect(s.unpushedCount).toBe(3);
    expect(s.unpushed.map((c) => c.subject)).toEqual(["feature 2", "feature 1", "feature 0"]);
    expect(s.unpushed[0]!.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(s.unpushed[0]!.authoredAt).toBeGreaterThan(0);
    expect(s.headSha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(s.baseSha).toBe(git(repo, "rev-parse", "origin/main"));
    expect(s.mergeBase).toBe(git(repo, "rev-parse", "HEAD~3"));
    expect(s.dirty).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pushed branch: unpushed counts only commits past origin/<branch>", async () => {
  const { root, repo } = fixture(2, 0);
  try {
    git(repo, "push", "-q", "origin", "feature");
    commit(repo, "late.txt", "x\n", "late");
    const s = await computeWorktreeStatus(repo, "main", "feature");
    expect(s.upstream).toBe("origin/feature");
    expect(s.aheadOfBase).toBe(3);
    expect(s.unpushedCount).toBe(1);
    expect(s.unpushed.map((c) => c.subject)).toEqual(["late"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty: a modified or an untracked file sets the flag", async () => {
  const { root, repo } = fixture(1, 0);
  try {
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    expect((await computeWorktreeStatus(repo, "main", "feature")).dirty).toBe(true);
    rmSync(join(repo, "new.txt"));
    writeFileSync(join(repo, "a.txt"), "edited\n");
    expect((await computeWorktreeStatus(repo, "main", "feature")).dirty).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpushed list is capped; the count is not", async () => {
  const { root, repo } = fixture(MAX_UNPUSHED_LISTED + 2, 0);
  try {
    const s = await computeWorktreeStatus(repo, "main", "feature");
    expect(s.unpushedCount).toBe(MAX_UNPUSHED_LISTED + 2);
    expect(s.unpushed).toHaveLength(MAX_UNPUSHED_LISTED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-isolated session (no branch) → nulls without invoking git", async () => {
  const s = await computeWorktreeStatus("/nonexistent", "main", null);
  expect(s).toMatchObject({ head: null, behindBase: null, unpushedCount: null, dirty: null });
  expect(s.unpushed).toEqual([]);
});

test("a base that reads as an option is rejected", async () => {
  await expect(computeWorktreeStatus("/nonexistent", "--output=x", "feature")).rejects.toThrow();
});
