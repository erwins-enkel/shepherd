import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeMgr } from "../src/worktree";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function commit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", msg], { cwd: dir, stdio: "pipe", env: GIT_ENV });
}

function localBranches(dir: string): string[] {
  return execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: dir, stdio: "pipe" })
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

let origin: string;
let repo: string;
beforeEach(() => {
  // A bare "origin" plus a clone, so a branch can live only on origin.
  origin = mkdtempSync(join(tmpdir(), "shepherd-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });

  const seed = mkdtempSync(join(tmpdir(), "shepherd-seed-"));
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "pipe" });
  commit(seed, "a.txt", "1", "init");
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: seed, stdio: "pipe" });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });
  // an integration branch that exists ONLY on origin
  execFileSync("git", ["checkout", "-q", "-b", "epic/9-x"], { cwd: seed, stdio: "pipe" });
  commit(seed, "b.txt", "2", "epic work");
  execFileSync("git", ["push", "-q", "origin", "epic/9-x"], { cwd: seed, stdio: "pipe" });
  rmSync(seed, { recursive: true, force: true });

  repo = mkdtempSync(join(tmpdir(), "shepherd-clone-"));
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "main", origin, repo], {
    stdio: "pipe",
  });
});
afterEach(() => {
  rmSync(origin, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("ensureBaseRef: local ref already exists (default branch) → no-op, no new branch", async () => {
  const wt = new WorktreeMgr();
  // main is the clone's local checkout branch — already resolves locally.
  expect(localBranches(repo)).toEqual(["main"]);
  await wt.ensureBaseRef(repo, "main");
  // still just main — nothing fetched/created
  expect(localBranches(repo)).toEqual(["main"]);
});

test("ensureBaseRef: origin-only branch is materialized into a local branch", async () => {
  const wt = new WorktreeMgr();
  // epic/9-x exists on origin but NOT locally (single-branch clone of main)
  expect(localBranches(repo)).not.toContain("epic/9-x");
  await wt.ensureBaseRef(repo, "epic/9-x");
  expect(localBranches(repo)).toContain("epic/9-x");
  // and it now resolves locally so a worktree can base on it
  const r = wt.create(repo, "epic/9-x", "child");
  expect(r.isolated).toBe(true);
  wt.remove(r.worktreePath);
});

test("ensureBaseRef: invalid base name is ignored (no throw, no branch)", async () => {
  const wt = new WorktreeMgr();
  await wt.ensureBaseRef(repo, "--evil");
  expect(localBranches(repo)).toEqual(["main"]);
});
