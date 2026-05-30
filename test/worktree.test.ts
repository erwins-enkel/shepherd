import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeMgr } from "../src/worktree";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "tank-wt-"));
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

test("create makes an isolated worktree on a tank/ branch", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "repo-flatten");
  expect(r.isolated).toBe(true);
  expect(r.branch).toBe("tank/repo-flatten");
  expect(existsSync(r.worktreePath)).toBe(true);
  wt.remove(r.worktreePath);
  expect(existsSync(r.worktreePath)).toBe(false);
  // branch must be retained after worktree removal
  const branches = execFileSync("git", ["branch", "--list", "tank/repo-flatten"], {
    cwd: repo,
  }).toString();
  expect(branches).toContain("tank/repo-flatten");
});

test("non-git dir falls back to cwd, not isolated", () => {
  const plain = mkdtempSync(join(tmpdir(), "tank-plain-"));
  const wt = new WorktreeMgr();
  const r = wt.create(plain, "main", "x");
  expect(r.isolated).toBe(false);
  expect(r.branch).toBeNull();
  expect(r.worktreePath).toBe(plain);
  rmSync(plain, { recursive: true, force: true });
});
