import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultComputePatchId } from "../src/review";

// `defaultComputePatchId` spawns git with INHERITED process.env and does NOT strip
// GIT_DIR/GIT_WORK_TREE. The Shepherd suite can run under an ambient GIT_DIR (e.g.
// inside a git hook), which would point the function-under-test at the WRONG repo.
// Save + clear them so BOTH our own setup git AND the function operate on the temp repo;
// restore afterward.
let savedGitDir: string | undefined;
let savedGitWorkTree: string | undefined;

const GIT_ID_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;
const tmpDirs: string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ID_ENV },
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

/** write a file then `git add` it (relative path under cwd). */
function writeAdd(cwd: string, rel: string, contents: string): void {
  writeFileSync(join(cwd, rel), contents);
  git(["add", rel], cwd);
}

function commit(cwd: string, msg: string): void {
  git(["commit", "-q", "-m", msg], cwd);
}

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Replicate the function's local-base path by hand: `git diff <base>...HEAD | git patch-id --stable`.
 *  Used to prove the function does NOT fold the same diff as a stale-local-main diff. */
function localPatchId(cwd: string, base: string): string | null {
  const diff = execFileSync("git", ["diff", `${base}...HEAD`], {
    cwd,
    env: { ...process.env, ...GIT_ID_ENV },
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  if (!diff.length) return null;
  const out = execFileSync("git", ["patch-id", "--stable"], {
    cwd,
    input: diff,
    stdio: ["pipe", "pipe", "ignore"],
  })
    .toString()
    .trim();
  return out.split(/\s+/)[0] || null;
}

beforeEach(() => {
  savedGitDir = process.env.GIT_DIR;
  savedGitWorkTree = process.env.GIT_WORK_TREE;
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;

  repo = mkTmp("shepherd-patchid-");
  git(["init", "-q", "-b", "main"], repo);
  writeAdd(repo, "base.txt", "baseline\n");
  commit(repo, "init");
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedGitDir !== undefined) process.env.GIT_DIR = savedGitDir;
  if (savedGitWorkTree !== undefined) process.env.GIT_WORK_TREE = savedGitWorkTree;
});

test("patch-id is invariant across a clean rebase onto an advanced local base", async () => {
  // No origin remote → the internal `git fetch origin` fails and the function falls back
  // to diffing against the LOCAL base ref. (Exercises the offline fallback path.)
  git(["checkout", "-q", "-b", "feature"], repo);
  writeAdd(repo, "feat.txt", "alpha\nbeta\ngamma\n");
  commit(repo, "feature change");

  const id1 = await defaultComputePatchId(repo, "main");
  expect(id1).toBeTruthy();
  expect(typeof id1).toBe("string");

  // advance main with an UNRELATED file, then rebase feature onto it
  git(["checkout", "-q", "main"], repo);
  writeAdd(repo, "unrelated.txt", "noise\n");
  commit(repo, "advance main");
  git(["checkout", "-q", "feature"], repo);
  git(["rebase", "-q", "main"], repo);

  const id2 = await defaultComputePatchId(repo, "main");
  expect(id2).toBe(id1);
});

test("patch-id changes when the branch's own content changes", async () => {
  git(["checkout", "-q", "-b", "feature"], repo);
  writeAdd(repo, "feat.txt", "alpha\nbeta\ngamma\n");
  commit(repo, "feature change");
  const before = await defaultComputePatchId(repo, "main");
  expect(before).toBeTruthy();

  // change a tracked line on feature (new commit)
  writeAdd(repo, "feat.txt", "alpha\nBETA-CHANGED\ngamma\n");
  commit(repo, "edit feature");
  const after = await defaultComputePatchId(repo, "main");
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);
});

test("patch-id is null when the branch has no diff against base", async () => {
  // a branch that sits exactly at main's tip → no diff → null
  git(["checkout", "-q", "-b", "feature"], repo);
  const id = await defaultComputePatchId(repo, "main");
  expect(id).toBeNull();

  // and main vs main is likewise empty
  git(["checkout", "-q", "main"], repo);
  expect(await defaultComputePatchId(repo, "main")).toBeNull();
});

test("offline (no origin remote) still returns a valid id via the local base fallback", async () => {
  // Explicitly document the fallback: no `git remote` is configured at all, so the internal
  // `git fetch origin -- main` errors and is swallowed; the function diffs the local base.
  expect(git(["remote"], repo)).toBe("");
  git(["checkout", "-q", "-b", "feature"], repo);
  writeAdd(repo, "feat.txt", "alpha\n");
  commit(repo, "feature change");

  const id = await defaultComputePatchId(repo, "main");
  expect(id).toBeTruthy();
  expect(typeof id).toBe("string");
  expect((id as string).length).toBeGreaterThan(0);
});

test("real origin: FETCH_HEAD path keeps the id stable when origin/main advances past the fork point (merge-train)", async () => {
  // Bare repo standing in for origin.
  const bare = mkTmp("shepherd-patchid-origin-");
  git(["init", "-q", "--bare"], bare);
  git(["remote", "add", "origin", bare], repo);
  git(["push", "-q", "origin", "main"], repo);

  // Branch feature off the current main and make its change; push it.
  git(["checkout", "-q", "-b", "feature"], repo);
  writeAdd(repo, "feat.txt", "alpha\nbeta\ngamma\n");
  commit(repo, "feature change");
  git(["push", "-q", "origin", "feature"], repo);

  // BEFORE: fingerprint with feature sitting at its original fork point.
  const before = await defaultComputePatchId(repo, "main");
  expect(before).toBeTruthy();

  // Advance origin/main with UNRELATED commits AFTER the branch point, WITHOUT moving the
  // working repo's local `main` ref to match. We do this from a throwaway clone so the
  // working repo's local `main` stays stale (simulating the merge-train: other PRs merged
  // into origin/main while this branch was in flight).
  // clone the bare origin into a fresh dir (git clone needs the target to not pre-exist;
  // mkdtemp's dir would be non-empty-safe but git refuses, so make a unique subpath).
  const pusherParent = mkTmp("shepherd-patchid-pusher-");
  const pusher = join(pusherParent, "clone");
  git(["clone", "-q", bare, pusher], pusherParent);
  writeAdd(pusher, "other-pr.txt", "merged elsewhere\n");
  commit(pusher, "unrelated PR merged to main");
  writeAdd(pusher, "other-pr2.txt", "another merge\n");
  commit(pusher, "second unrelated PR");
  git(["push", "-q", "origin", "main"], pusher);

  // The working repo's local `main` is now STALE (lags origin/main by 2 commits).
  const localMain = git(["rev-parse", "main"], repo);
  git(["fetch", "-q", "origin"], repo);
  const originMain = git(["rev-parse", "origin/main"], repo);
  expect(localMain).not.toBe(originMain); // confirm the stale-local-main setup

  // Rebase feature onto the advanced origin/main (clean — feature's change is independent).
  git(["rebase", "-q", "origin/main"], repo);

  // AFTER: the function fetches origin/main fresh and diffs FETCH_HEAD...HEAD, so the
  // merge-base is the TRUE current fork point → fingerprint stable across the clean rebase.
  const after = await defaultComputePatchId(repo, "main");
  expect(after).toBe(before);

  // Contrast: a STALE-LOCAL-main diff (what the pre-fix code did) folds the two unrelated
  // origin commits into the diff, so its patch-id DIFFERS from the function's fetched-base
  // result — proving the function used the fresh base, not the lagging local ref.
  const stale = localPatchId(repo, localMain);
  expect(stale).toBeTruthy();
  expect(stale).not.toBe(after);
});
