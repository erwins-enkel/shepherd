import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  HANDOFF_WIP_SUBJECT,
  HandoffGitError,
  commitAndPushForHandoff,
  copyHandoffFile,
  handoffFiles,
  isUploadName,
} from "../src/session-handoff";
import { WorktreeMgr } from "../src/worktree";

// The source half of a session move: everything the agent left uncommitted becomes one WIP commit,
// and the work branch is pushed so the target machine can check that very branch out.

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
let repo: string;
let worktreePath: string;
let branch: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-handoff-"));
  origin = join(root, "origin.git");
  repo = join(root, "projects", "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  writeFileSync(join(repo, "README"), "init");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  const wt = new WorktreeMgr().create(repo, "main", "task");
  worktreePath = wt.worktreePath;
  branch = wt.branch!;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("commits tracked and untracked changes once and pushes the branch", async () => {
  writeFileSync(join(worktreePath, "README"), "changed");
  writeFileSync(join(worktreePath, "new.txt"), "new");
  // Shepherd's own artifacts stay out of the snapshot (excluded per repo)
  writeFileSync(join(worktreePath, ".shepherd-plan.md"), "plan");
  const r = await commitAndPushForHandoff({
    repoPath: repo,
    worktreePath,
    branch,
    targetName: "macbook",
  });
  expect(r.committed).toBe(true);
  expect(git(worktreePath, "log", "-1", "--format=%s")).toBe(`${HANDOFF_WIP_SUBJECT} macbook`);
  expect(git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(r.headCommit);
  const files = git(worktreePath, "show", "--name-only", "--format=", "HEAD").split("\n");
  expect(files.sort()).toEqual(["README", "new.txt"]);
  // nothing is left behind: the plan is excluded, everything else is in the snapshot
  expect(git(worktreePath, "status", "--porcelain")).toBe("");
});

test("a clean worktree pushes the branch without a commit", async () => {
  writeFileSync(join(worktreePath, "work.txt"), "w");
  git(worktreePath, "add", "work.txt");
  git(worktreePath, "commit", "-q", "-m", "work");
  const head = git(worktreePath, "rev-parse", "HEAD");
  const r = await commitAndPushForHandoff({
    repoPath: repo,
    worktreePath,
    branch,
    targetName: "m",
  });
  expect(r).toEqual({ committed: false, headCommit: head });
  expect(git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(head);
});

test("a branch someone else advanced on origin is refused, never overwritten", async () => {
  await commitAndPushForHandoff({ repoPath: repo, worktreePath, branch, targetName: "m" });
  // another clone pushes to the same branch
  const other = join(root, "other");
  git(root, "clone", "-q", "-b", branch, origin, other);
  writeFileSync(join(other, "theirs.txt"), "x");
  git(other, "add", "theirs.txt");
  git(other, "commit", "-q", "-m", "theirs");
  git(other, "push", "-q", "origin", branch);
  const theirs = git(other, "rev-parse", "HEAD");
  // local work diverges
  writeFileSync(join(worktreePath, "mine.txt"), "y");
  const err = await commitAndPushForHandoff({
    repoPath: repo,
    worktreePath,
    branch,
    targetName: "m",
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HandoffGitError);
  expect((err as HandoffGitError).code).toBe("handoff_push_failed");
  expect(git(origin, "rev-parse", `refs/heads/${branch}`)).toBe(theirs);
});

test("handoffFiles lists the plan first, then regular uploads; symlinks are skipped", () => {
  writeFileSync(join(worktreePath, ".shepherd-plan.md"), "plan");
  mkdirSync(join(worktreePath, ".shepherd-uploads"));
  writeFileSync(join(worktreePath, ".shepherd-uploads", "b.png"), "b");
  writeFileSync(join(worktreePath, ".shepherd-uploads", "a.png"), "a");
  symlinkSync("/etc/hostname", join(worktreePath, ".shepherd-uploads", "c.png"));
  expect(handoffFiles(worktreePath)).toEqual([
    ".shepherd-plan.md",
    ".shepherd-uploads/a.png",
    ".shepherd-uploads/b.png",
  ]);
});

test("copyHandoffFile copies only the plan or a plain upload inside the worktree", () => {
  mkdirSync(join(worktreePath, ".shepherd-uploads"));
  writeFileSync(join(worktreePath, ".shepherd-uploads", "a.png"), "a");
  symlinkSync("/etc/hostname", join(worktreePath, ".shepherd-uploads", "link.png"));
  const dest = join(root, "staged.png");
  expect(copyHandoffFile(worktreePath, ".shepherd-uploads/a.png", dest)).toBe(true);
  expect(readFileSync(dest, "utf8")).toBe("a");
  expect(copyHandoffFile(worktreePath, ".shepherd-uploads/link.png", join(root, "x"))).toBe(false);
  expect(copyHandoffFile(worktreePath, "README", join(root, "y"))).toBe(false);
  expect(isUploadName(".shepherd-uploads/../README")).toBe(false);
  expect(isUploadName(".shepherd-uploads/..")).toBe(false);
  expect(isUploadName(".shepherd-uploads/a.png")).toBe(true);
});
