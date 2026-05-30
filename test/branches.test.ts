import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { listBranches } from "../src/branches";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shepherd-br-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env: GIT_ENV });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("lists local branches with the current branch", () => {
  execFileSync("git", ["branch", "feature-x"], { cwd: repo, env: GIT_ENV });
  const r = listBranches(repo);
  expect(r.branches).toContain("main");
  expect(r.branches).toContain("feature-x");
  expect(r.current).toBe("main");
});

test("sorts most-recently-committed branch first", () => {
  execFileSync("git", ["checkout", "-q", "-b", "newer"], { cwd: repo, env: GIT_ENV });
  // force a strictly-later commit date (second-granularity ties otherwise within the test)
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "second"], {
    cwd: repo,
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_DATE: "2030-01-01T00:00:00",
      GIT_COMMITTER_DATE: "2030-01-01T00:00:00",
    },
  });
  const r = listBranches(repo);
  expect(r.branches[0]).toBe("newer");
});

test("non-git dir → empty list, null current", () => {
  const plain = mkdtempSync(join(tmpdir(), "shepherd-plain-"));
  try {
    const r = listBranches(plain);
    expect(r.branches).toEqual([]);
    expect(r.current).toBeNull();
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
