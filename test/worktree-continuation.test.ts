import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ContinuationBranchError, WorktreeMgr } from "../src/worktree";

// A session move (Continue with… on another machine): the target checks out the work branch the
// source pushed, under the same name, so an open PR stays the same.

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();

let root: string;
let origin: string;
let source: string;
let target: string;
const BRANCH = "shepherd/moved-task";

function commitFile(cwd: string, name: string, body: string): string {
  writeFileSync(join(cwd, name), body);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-wt-cont-"));
  origin = join(root, "origin.git");
  source = join(root, "source");
  target = join(root, "projects", "target");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, source);
  commitFile(source, "README", "init");
  git(source, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, target);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The source's work: a branch off main with one commit, pushed. Returns [forkPoint, head]. */
function pushWork(): [string, string] {
  const fork = git(source, "rev-parse", "main");
  git(source, "checkout", "-q", "-b", BRANCH);
  const head = commitFile(source, "work.txt", "work");
  git(source, "push", "-q", "-u", "origin", BRANCH);
  return [fork, head];
}

test("checks out the pushed branch under its own name with upstream and the fork point as base", async () => {
  const [fork, head] = pushWork();
  // main moves on after the fork: the base is the fork point, not main's tip or HEAD
  commitFile(source, "later.txt", "x");
  git(source, "push", "-q", "origin", `HEAD:refs/heads/side`);
  const wt = new WorktreeMgr();
  const r = await wt.createOnBranch(target, {
    branch: BRANCH,
    headCommit: head,
    baseRef: "origin/main",
    name: "moved-task-2",
  });
  expect(r.branch).toBe(BRANCH);
  expect(r.isolated).toBe(true);
  expect(git(r.worktreePath, "rev-parse", "HEAD")).toBe(head);
  expect(git(r.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
  expect(git(r.worktreePath, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${BRANCH}`);
  expect(r.baseCommit).toBe(fork);
});

test("refuses a branch whose origin tip does not contain the pushed head (stale)", async () => {
  pushWork();
  // a commit that never reached origin
  const unpushed = commitFile(source, "unpushed.txt", "x");
  const wt = new WorktreeMgr();
  const err = await wt
    .createOnBranch(target, {
      branch: BRANCH,
      headCommit: unpushed,
      baseRef: "origin/main",
      name: "n",
    })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ContinuationBranchError);
  expect((err as ContinuationBranchError).code).toBe("continuation_stale");
});

test("refuses a missing remote branch", async () => {
  const head = git(source, "rev-parse", "main");
  const wt = new WorktreeMgr();
  const err = await wt
    .createOnBranch(target, {
      branch: "shepherd/nope",
      headCommit: head,
      baseRef: "origin/main",
      name: "n",
    })
    .catch((e: unknown) => e);
  expect((err as ContinuationBranchError).code).toBe("continuation_fetch_failed");
});

test("resets a local branch of that name only when origin already contains it", async () => {
  const [, head] = pushWork();
  // a stale local copy (behind origin) left by an earlier session here
  git(target, "fetch", "-q", "origin");
  git(target, "branch", BRANCH, "origin/main");
  const wt = new WorktreeMgr();
  const r = await wt.createOnBranch(target, {
    branch: BRANCH,
    headCommit: head,
    baseRef: "origin/main",
    name: "reset-ok",
  });
  expect(git(r.worktreePath, "rev-parse", "HEAD")).toBe(head);
});

test("refuses a local branch with commits origin does not have (diverged)", async () => {
  const [, head] = pushWork();
  git(target, "fetch", "-q", "origin");
  git(target, "checkout", "-q", "-b", BRANCH, "origin/main");
  commitFile(target, "local-only.txt", "x");
  git(target, "checkout", "-q", "main");
  const wt = new WorktreeMgr();
  const err = await wt
    .createOnBranch(target, { branch: BRANCH, headCommit: head, baseRef: "origin/main", name: "n" })
    .catch((e: unknown) => e);
  expect((err as ContinuationBranchError).code).toBe("continuation_diverged");
});

test("refuses a branch another worktree has checked out", async () => {
  const [, head] = pushWork();
  git(target, "fetch", "-q", "origin");
  git(target, "checkout", "-q", "-b", BRANCH, `origin/${BRANCH}`);
  const wt = new WorktreeMgr();
  const err = await wt
    .createOnBranch(target, { branch: BRANCH, headCommit: head, baseRef: "origin/main", name: "n" })
    .catch((e: unknown) => e);
  expect((err as ContinuationBranchError).code).toBe("continuation_branch_in_use");
});
