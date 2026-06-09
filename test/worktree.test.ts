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

test("currentBranch reports the worktree's checked-out branch and follows a rename", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "view-refresh");
  expect(wt.currentBranch(r.worktreePath)).toBe("shepherd/view-refresh");
  // agent renames the branch out from under the stored value
  execFileSync("git", ["branch", "-m", "shepherd/view-refresh", "shepherd/refresh-on-wake"], {
    cwd: r.worktreePath,
  });
  expect(wt.currentBranch(r.worktreePath)).toBe("shepherd/refresh-on-wake");
  wt.remove(r.worktreePath);
});

test("currentBranch returns null on a detached HEAD", () => {
  const wt = new WorktreeMgr();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const r = wt.createDetached(repo, "main", sha, "sess-detached");
  expect(wt.currentBranch(r.worktreePath)).toBeNull();
  wt.remove(r.worktreePath);
});

test("containsCommit distinguishes this branch's commits from a foreign (name-collision) head", () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const wt = new WorktreeMgr();

  // A "foreign" commit on a branch that this session's branch will NOT contain —
  // stand-in for a prior, already-merged PR's head that reused the branch name.
  execFileSync("git", ["checkout", "-q", "-b", "old-feature"], { cwd: repo });
  writeFileSync(join(repo, "old.txt"), "old");
  execFileSync("git", ["add", "old.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "old work"], { cwd: repo, env: gitEnv });
  const foreignSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });

  // Fresh session worktree cut from main — it never contained `foreignSha`.
  const r = wt.create(repo, "main", "capture-signals");
  const ownSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.worktreePath })
    .toString()
    .trim();

  expect(wt.containsCommit(r.worktreePath, ownSha)).toBe(true); // own branch tip
  expect(wt.containsCommit(r.worktreePath, foreignSha)).toBe(false); // foreign PR head
  expect(wt.containsCommit(r.worktreePath, "0".repeat(40))).toBe(false); // absent object
  expect(wt.containsCommit(r.worktreePath, "nonsense!")).toBeNull(); // malformed → unknown

  wt.remove(r.worktreePath);
});

test("containsCommit returns null (not false) when the worktree path is unusable", () => {
  const wt = new WorktreeMgr();
  // git can't run against a non-existent cwd → spawn failure, no exit code. This
  // must be unknowable (null), not a clean miss (false): a broken worktree is not
  // evidence the commit is foreign.
  expect(wt.containsCommit(join(repo, "does-not-exist"), "a".repeat(40))).toBeNull();
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
  const wt = mgr.createDetached(repo, "feat/x", sha, "sess-1");

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
  expect(() => mgr.createDetached(repo, "--upload-pack=evil", sha, "s")).toThrow("invalid branch");
  expect(() => mgr.createDetached(repo, "-x", sha, "s")).toThrow("invalid branch");
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
  const first = mgr.createDetached(repo, "feat/x", sha, "sess-1");
  // simulate a restart: the in-memory inflight record is gone but the worktree
  // dir + registration remain. The SAME session re-spawning for the same head
  // (same key+sha) must reclaim its tree rather than fail on an occupied dir.
  const second = mgr.createDetached(repo, "feat/x", sha, "sess-1");
  expect(second.worktreePath).toBe(first.worktreePath);
  expect(existsSync(second.worktreePath)).toBe(true);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: second.worktreePath })
    .toString()
    .trim();
  expect(head).toBe(sha);

  mgr.remove(second.worktreePath);
});

test("createDetached: distinct keys never share a path (no cross-streamed verdict)", () => {
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
  // Two sessions branched off the SAME base resolve the SAME sha — the exact
  // 267/272 case. Their reviewer worktrees (and thus their verdict files) must
  // stay separate so one session's review can't land in the other's pane.
  const a = mgr.createDetached(repo, "feat/x", sha, "sess-267");
  const b = mgr.createDetached(repo, "feat/x", sha, "sess-272");
  expect(a.worktreePath).not.toBe(b.worktreePath);
  expect(existsSync(a.worktreePath)).toBe(true);
  expect(existsSync(b.worktreePath)).toBe(true);

  mgr.remove(a.worktreePath);
  mgr.remove(b.worktreePath);
});

test("behindBase: false when up-to-date, true when base advanced", () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "a"), "1");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "b"), "1");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "feat"], { cwd: dir, stdio: "pipe" });
  const wt = new WorktreeMgr();
  // feat contains main's tip → up-to-date
  expect(wt.behindBase(dir, "main")).toBe(false);
  // advance main beyond feat
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "c"), "1");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "main2"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-q", "feat"], { cwd: dir, stdio: "pipe" });
  expect(wt.behindBase(dir, "main")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
