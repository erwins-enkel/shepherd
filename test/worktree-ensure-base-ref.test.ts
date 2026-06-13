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

function revParse(dir: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], { cwd: dir, stdio: "pipe" }).toString().trim();
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

test("ensureBaseRef: checked-out (default) branch is NOT fetched → no-op, stays at local tip", async () => {
  const wt = new WorktreeMgr();
  // main is the clone's local checkout branch — git refuses to fetch into it.
  expect(localBranches(repo)).toEqual(["main"]);
  const before = revParse(repo, "main");

  // Advance origin/main from a second clone so a fetch (if it wrongly happened) would move it.
  const other = mkdtempSync(join(tmpdir(), "shepherd-other-"));
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
  commit(other, "a.txt", "advanced", "advance main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  rmSync(other, { recursive: true, force: true });

  await wt.ensureBaseRef(repo, "main");
  // still just main, still at the original local tip — the checked-out branch is skipped.
  expect(localBranches(repo)).toEqual(["main"]);
  expect(revParse(repo, "main")).toBe(before);
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

test("ensureBaseRef: existing local integration branch is fast-forwarded to origin tip", async () => {
  const wt = new WorktreeMgr();
  // C1: materialize local epic/9-x at origin's current tip.
  await wt.ensureBaseRef(repo, "epic/9-x");
  expect(localBranches(repo)).toContain("epic/9-x");
  const c1 = revParse(repo, "epic/9-x");

  // C2: a sibling advances origin/epic/9-x (simulates a sibling PR squash-merging into it).
  const other = mkdtempSync(join(tmpdir(), "shepherd-sibling-"));
  execFileSync("git", ["clone", "-q", "--branch", "epic/9-x", origin, other], { stdio: "pipe" });
  commit(other, "c.txt", "sibling work", "sibling merge");
  execFileSync("git", ["push", "-q", "origin", "epic/9-x"], { cwd: other, stdio: "pipe" });
  const c2 = revParse(other, "epic/9-x");
  rmSync(other, { recursive: true, force: true });
  expect(c2).not.toBe(c1); // origin genuinely advanced

  // Second spawn: local epic/9-x must fast-forward to C2, not stay stale at C1.
  await wt.ensureBaseRef(repo, "epic/9-x");
  expect(revParse(repo, "epic/9-x")).toBe(c2);
  expect(revParse(repo, "epic/9-x")).not.toBe(c1);
});

test("ensureBaseRef: invalid base name is ignored (no throw, no branch)", async () => {
  const wt = new WorktreeMgr();
  await wt.ensureBaseRef(repo, "--evil");
  expect(localBranches(repo)).toEqual(["main"]);
});
