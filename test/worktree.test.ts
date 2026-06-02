import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeMgr } from "../src/worktree";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shepherd-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("create makes an isolated worktree on a shepherd/ branch", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "repo-flatten");
  expect(r.isolated).toBe(true);
  expect(r.branch).toBe("shepherd/repo-flatten");
  expect(existsSync(r.worktreePath)).toBe(true);
  wt.remove(r.worktreePath);
  expect(existsSync(r.worktreePath)).toBe(false);
  // branch must be retained after worktree removal
  const branches = execFileSync("git", ["branch", "--list", "shepherd/repo-flatten"], {
    cwd: repo,
  }).toString();
  expect(branches).toContain("shepherd/repo-flatten");
});

test("remove force-deletes the workspace even when git worktree remove refuses", () => {
  const wt = new WorktreeMgr();
  // a populated dir inside the repo that git does NOT track as a worktree:
  // `git worktree remove` errors on it, so cleanup must fall back to the filesystem
  const stray = join(repo, "stray-workspace");
  mkdirSync(stray);
  writeFileSync(join(stray, "f.txt"), "x");
  wt.remove(stray);
  expect(existsSync(stray)).toBe(false);
});

test("remove prunes the stale worktree registration", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "prune-me");
  wt.remove(r.worktreePath);
  // no dangling entry left in `git worktree list`
  const list = execFileSync("git", ["worktree", "list"], { cwd: repo }).toString();
  expect(list).not.toContain(r.worktreePath);
});

test("remove deletes the branch once it's merged into its base", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "merged");
  // fresh branch sits at main's tip → already an ancestor of main (nothing to lose)
  wt.remove(r.worktreePath, { branch: r.branch, baseBranch: "main" });
  const branches = execFileSync("git", ["branch", "--list", "shepherd/merged"], {
    cwd: repo,
  }).toString();
  expect(branches.trim()).toBe("");
});

test("remove retains the branch when it has unmerged commits", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "wip");
  // a commit that exists only on the session branch → not merged into main
  writeFileSync(join(r.worktreePath, "wip.txt"), "x");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execFileSync("git", ["add", "-A"], { cwd: r.worktreePath });
  execFileSync("git", ["commit", "-q", "-m", "wip"], { cwd: r.worktreePath, env });
  wt.remove(r.worktreePath, { branch: r.branch, baseBranch: "main" });
  const branches = execFileSync("git", ["branch", "--list", "shepherd/wip"], {
    cwd: repo,
  }).toString();
  expect(branches).toContain("shepherd/wip");
});

test("non-git dir falls back to cwd, not isolated", () => {
  const plain = mkdtempSync(join(tmpdir(), "shepherd-plain-"));
  const wt = new WorktreeMgr();
  const r = wt.create(plain, "main", "x");
  expect(r.isolated).toBe(false);
  expect(r.branch).toBeNull();
  expect(r.worktreePath).toBe(plain);
  rmSync(plain, { recursive: true, force: true });
});

test("create with leading-dash baseBranch throws", () => {
  const wt = new WorktreeMgr();
  expect(() => wt.create(repo, "--evil", "x")).toThrow("invalid baseBranch");
});

test("create with semicolon in baseBranch throws", () => {
  const wt = new WorktreeMgr();
  expect(() => wt.create(repo, "feat;rm -rf /", "x")).toThrow("invalid baseBranch");
});

test("createDetached: checks out a detached worktree at the given sha", () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  // create a branch with a commit so we have a sha to detach at
  execFileSync("git", ["checkout", "-b", "feat/x"], { cwd: repo });
  writeFileSync(join(repo, "feat.txt"), "hello");
  execFileSync("git", ["add", "feat.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "feat commit"], { cwd: repo, env });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

  const mgr = new WorktreeMgr();
  const wt = mgr.createDetached(repo, "feat/x", sha);

  expect(existsSync(wt.worktreePath)).toBe(true);
  expect(wt.branch).toBeNull();
  expect(wt.isolated).toBe(true);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.worktreePath })
    .toString()
    .trim();
  expect(head).toBe(sha);

  mgr.remove(wt.worktreePath);
  expect(existsSync(wt.worktreePath)).toBe(false);
});

test("createDetached: rejects a branch that could smuggle a git flag", () => {
  const mgr = new WorktreeMgr();
  const sha = "0".repeat(40);
  expect(() => mgr.createDetached(repo, "--upload-pack=evil", sha)).toThrow("invalid branch");
  expect(() => mgr.createDetached(repo, "-x", sha)).toThrow("invalid branch");
});

test("commitsAhead: 0 when branch tip == base, >0 after a commit", () => {
  execFileSync("git", ["checkout", "-b", "feat"], { cwd: repo, stdio: "pipe" });
  const wt = new WorktreeMgr();
  expect(wt.commitsAhead(repo, "main", "feat")).toBe(0);
  execFileSync("git", ["commit", "--allow-empty", "-m", "x"], {
    cwd: repo,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  expect(wt.commitsAhead(repo, "main", "feat")).toBe(1);
});

test("createDetached: reclaims a stale worktree path left by an interrupted run", () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  execFileSync("git", ["checkout", "-b", "feat/x"], { cwd: repo });
  writeFileSync(join(repo, "feat.txt"), "hello");
  execFileSync("git", ["add", "feat.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "feat commit"], { cwd: repo, env });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

  const mgr = new WorktreeMgr();
  const first = mgr.createDetached(repo, "feat/x", sha);
  // simulate a restart: the in-memory inflight record is gone but the worktree
  // dir + registration remain. A re-spawn for the same head must still succeed.
  const second = mgr.createDetached(repo, "feat/x", sha);
  expect(second.worktreePath).toBe(first.worktreePath);
  expect(existsSync(second.worktreePath)).toBe(true);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: second.worktreePath })
    .toString()
    .trim();
  expect(head).toBe(sha);

  mgr.remove(second.worktreePath);
});
