// test/local-forge.test.ts — LocalForge against REAL git in temp repos.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionStore } from "../src/store";
import {
  LocalForge,
  squashMergeLocal,
  mergeTreeWriteTree,
  parseGitVersion,
  gitVersionAtLeast,
  parseWorktrees,
  BaseCheckoutBusyError,
  MergeConflictError,
} from "../src/forge/local";
import { EmptyDiffError } from "../src/forge/types";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: ENV, stdio: "pipe" }).toString().trim();

/** A repo on `main` with one commit (file a=1). */
function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-lf-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

/** Cut `branch` off main and add `n` commits each touching its own file. */
function featureBranch(repo: string, branch: string, n = 2): void {
  git(repo, "checkout", "-q", "-b", branch);
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repo, `f${i}.txt`), `feature ${i}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", `feat ${i}`);
  }
}

function revParse(repo: string, ref: string): string {
  return git(repo, "rev-parse", ref);
}

function isAncestor(repo: string, a: string, b: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", a, b], {
      cwd: repo,
      env: ENV,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// ── version helper ──────────────────────────────────────────────────────────

test("parseGitVersion parses major/minor from `git version` strings", () => {
  expect(parseGitVersion("git version 2.54.0")).toEqual({ major: 2, minor: 54 });
  expect(parseGitVersion("git version 2.38.1.windows.1")).toEqual({ major: 2, minor: 38 });
  expect(parseGitVersion("git version 2.37.0")).toEqual({ major: 2, minor: 37 });
  expect(parseGitVersion("garbage")).toBeNull();
});

test("gitVersionAtLeast: 2.37 rejected, 2.38 and 2.54 accepted", () => {
  expect(gitVersionAtLeast({ major: 2, minor: 37 }, 2, 38)).toBe(false);
  expect(gitVersionAtLeast({ major: 2, minor: 38 }, 2, 38)).toBe(true);
  expect(gitVersionAtLeast({ major: 2, minor: 54 }, 2, 38)).toBe(true);
  expect(gitVersionAtLeast({ major: 3, minor: 0 }, 2, 38)).toBe(true);
  expect(gitVersionAtLeast({ major: 1, minor: 99 }, 2, 38)).toBe(false);
});

// ── prStatus / openPr ───────────────────────────────────────────────────────

test("LocalForge is lightweight and has no remote backlog counts", async () => {
  const repo = mkRepo();
  try {
    const forge = new LocalForge(repo, new SessionStore(":memory:"));
    expect(forge.isLightweight).toBe(true);
    expect(await forge.listBacklogCounts()).toEqual({
      openIssues: null,
      openPRs: null,
      ciStatus: null,
      prKinds: null,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prStatus for an unknown branch → state:none", async () => {
  const repo = mkRepo();
  try {
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const st = await forge.prStatus("feature/nope");
    expect(st.state).toBe("none");
    expect(st.checks).toBe("none");
    expect(st.deployConfigured).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("openPr then prStatus → open, positive number, mergeable:true, headSha=tip", async () => {
  const repo = mkRepo();
  try {
    featureBranch(repo, "feature/x");
    git(repo, "checkout", "-q", "main");
    const tip = revParse(repo, "feature/x");
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);

    const opened = await forge.openPr({ head: "feature/x", base: "main", title: "t", body: "b" });
    expect(opened.state).toBe("open");
    expect(opened.number).toBeGreaterThan(0);
    expect(opened.checks).toBe("success");
    expect(opened.mergeable).toBe(true);
    expect(opened.headSha).toBe(tip);

    const st = await forge.prStatus("feature/x");
    expect(st.state).toBe("open");
    expect(st.number).toBe(opened.number);
    expect(st.mergeable).toBe(true);
    expect(st.headSha).toBe(tip);
    expect(st.createdAt).toBeGreaterThan(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("openPr throws EmptyDiffError when the branch has no commits ahead of base", async () => {
  const repo = mkRepo();
  try {
    // a branch off main with NO further commits → nothing to open a PR for
    git(repo, "checkout", "-q", "-b", "feature/empty");
    git(repo, "checkout", "-q", "main");
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    let threw: unknown;
    try {
      await forge.openPr({ head: "feature/empty", base: "main", title: "t", body: "b" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(EmptyDiffError);
    // no pseudo-PR row registered
    expect(store.getLocalPr(repo, "feature/empty")).toBeNull();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("openPr succeeds for a branch with commits ahead of base", async () => {
  const repo = mkRepo();
  try {
    featureBranch(repo, "feature/has-commits", 1);
    git(repo, "checkout", "-q", "main");
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const opened = await forge.openPr({
      head: "feature/has-commits",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(opened.state).toBe("open");
    expect(opened.number).toBeGreaterThan(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("defaultBranch returns the primary checkout branch", async () => {
  const repo = mkRepo();
  try {
    const forge = new LocalForge(repo, new SessionStore(":memory:"));
    expect(await forge.defaultBranch()).toBe("main");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── squash merge: base NOT checked out ──────────────────────────────────────

test("squash merge with base detached (not checked out) advances base by one squash commit", async () => {
  const repo = mkRepo();
  try {
    const baseTip = revParse(repo, "main");
    featureBranch(repo, "feature/y", 3);
    const branchCommits = git(repo, "rev-list", "main..feature/y").split("\n").filter(Boolean);
    // detach primary checkout so main is checked out nowhere
    git(repo, "checkout", "-q", "--detach");

    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const pr = await forge.openPr({ head: "feature/y", base: "main", title: "t", body: "b" });
    await forge.merge(pr.number!);

    const newMain = revParse(repo, "refs/heads/main");
    // exactly one new commit, parent = old base tip
    expect(revParse(repo, "refs/heads/main^")).toBe(baseTip);
    expect(newMain).not.toBe(baseTip);
    // tree equals the feature tree (full merge result)
    expect(revParse(repo, "refs/heads/main^{tree}")).toBe(revParse(repo, "feature/y^{tree}"));
    // squash: the feature's individual commits are NOT in base history
    for (const c of branchCommits) {
      expect(isAncestor(repo, c, "refs/heads/main")).toBe(false);
    }
    // row merged
    expect(store.getLocalPrByNumber(pr.number!)!.state).toBe("merged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── squash merge: base CHECKED OUT clean (headline) ─────────────────────────

test("squash merge with base checked out clean advances HEAD without dirtying the tree", async () => {
  const repo = mkRepo();
  try {
    const baseTip = revParse(repo, "main");
    featureBranch(repo, "feature/z", 2);
    git(repo, "checkout", "-q", "main"); // base IS checked out in the primary worktree

    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const pr = await forge.openPr({ head: "feature/z", base: "main", title: "t", body: "b" });
    await forge.merge(pr.number!);

    // HEAD advanced to the squash commit
    expect(revParse(repo, "HEAD^")).toBe(baseTip);
    expect(revParse(repo, "HEAD")).toBe(revParse(repo, "refs/heads/main"));
    // working tree still clean (no desync)
    const status = git(repo, "status", "--porcelain");
    expect(status).toBe("");
    expect(store.getLocalPrByNumber(pr.number!)!.state).toBe("merged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── squash merge: base checked out DIRTY → abort, nothing moves ─────────────

test("squash merge with base checked out dirty throws BaseCheckoutBusyError and moves no ref", async () => {
  const repo = mkRepo();
  try {
    const baseTip = revParse(repo, "main");
    featureBranch(repo, "feature/d", 1);
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "dirty\n"); // uncommitted change in the base worktree

    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const pr = await forge.openPr({ head: "feature/d", base: "main", title: "t", body: "b" });

    let threw: unknown;
    try {
      await forge.merge(pr.number!);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(BaseCheckoutBusyError);
    // no ref moved
    expect(revParse(repo, "refs/heads/main")).toBe(baseTip);
    // row still open
    expect(store.getLocalPrByNumber(pr.number!)!.state).toBe("open");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── merge conflict → throw, nothing moves ───────────────────────────────────

test("squash merge with a real conflict throws MergeConflictError and moves no ref", async () => {
  const repo = mkRepo();
  try {
    // base edits a.txt
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "base-line\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base edit");
    const baseTip = revParse(repo, "main");
    // branch off the ORIGINAL commit and edit the same line differently
    git(repo, "checkout", "-q", "-b", "feature/c", "main~1");
    writeFileSync(join(repo, "a.txt"), "branch-line\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "branch edit");
    git(repo, "checkout", "-q", "--detach");

    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const pr = await forge.openPr({ head: "feature/c", base: "main", title: "t", body: "b" });

    let threw: unknown;
    try {
      await forge.merge(pr.number!);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(MergeConflictError);
    expect(revParse(repo, "refs/heads/main")).toBe(baseTip);
    expect(store.getLocalPrByNumber(pr.number!)!.state).toBe("open");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── merge-tree exit-code decoding: clean / conflict / genuine error ─────────

test("mergeTreeWriteTree returns a tree on a clean merge, conflict flag on a conflict", async () => {
  const repo = mkRepo();
  try {
    featureBranch(repo, "feature/clean", 1);
    git(repo, "checkout", "-q", "--detach");
    const clean = await mergeTreeWriteTree(repo, "main", "feature/clean");
    expect(clean.conflict).toBe(false);
    expect(clean.tree).toMatch(/^[0-9a-f]{40}$/);

    // a real conflict (exit 1) → conflict flag, no throw
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "a.txt"), "base-line\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base edit");
    git(repo, "checkout", "-q", "-b", "feature/cf", "main~1");
    writeFileSync(join(repo, "a.txt"), "branch-line\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "branch edit");
    git(repo, "checkout", "-q", "--detach");
    const conflict = await mergeTreeWriteTree(repo, "main", "feature/cf");
    expect(conflict.conflict).toBe(true);
    expect(conflict.tree).toBeUndefined();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("mergeTreeWriteTree throws (NOT a conflict) on a genuine git error — exit >1", async () => {
  // A non-git directory makes `git merge-tree` exit 128 (fatal: not a git repository).
  // git reserves exit 1 for a real conflict and >1 for genuine failures — the >1 case
  // must surface as a plain Error, never be decoded as a MergeConflictError (a 409).
  const nongit = mkdtempSync(join(tmpdir(), "shepherd-lf-nongit-"));
  try {
    let threw: unknown;
    try {
      await mergeTreeWriteTree(nongit, "main", "x");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(threw).not.toBeInstanceOf(MergeConflictError);
    expect(String((threw as Error).message)).toContain("merge-tree");
  } finally {
    rmSync(nongit, { recursive: true, force: true });
  }
});

// ── branch prune hook: branch becomes ancestor of base ──────────────────────

test("after merge the feature branch ref points at the squash commit (ancestor of base)", async () => {
  const repo = mkRepo();
  try {
    featureBranch(repo, "feature/p", 2);
    git(repo, "checkout", "-q", "--detach");
    const store = new SessionStore(":memory:");
    const forge = new LocalForge(repo, store);
    const pr = await forge.openPr({ head: "feature/p", base: "main", title: "t", body: "b" });
    await forge.merge(pr.number!);

    // branch still exists (we passed deleteBranch:false / forge ignores it) and is now
    // the squash commit == an ancestor of base, so pruneMergedBranch will delete it.
    expect(revParse(repo, "refs/heads/feature/p")).toBe(revParse(repo, "refs/heads/main"));
    expect(isAncestor(repo, "refs/heads/feature/p", "refs/heads/main")).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── direct squashMergeLocal export ──────────────────────────────────────────

test("squashMergeLocal is exported and merges directly (base detached)", async () => {
  const repo = mkRepo();
  try {
    const baseTip = revParse(repo, "main");
    featureBranch(repo, "feature/direct", 1);
    git(repo, "checkout", "-q", "--detach");
    await squashMergeLocal(repo, "feature/direct", "main");
    expect(revParse(repo, "refs/heads/main^")).toBe(baseTip);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── merge of an unknown number throws ───────────────────────────────────────

test("merge of an unknown PR number throws a clear error", async () => {
  const repo = mkRepo();
  try {
    const forge = new LocalForge(repo, new SessionStore(":memory:"));
    let threw: unknown;
    try {
      await forge.merge(424242);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("424242");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── capability guard ────────────────────────────────────────────────────────

test("squashMergeLocal surfaces a clear error when git is too old (injected probe)", async () => {
  const repo = mkRepo();
  try {
    featureBranch(repo, "feature/old", 1);
    git(repo, "checkout", "-q", "--detach");
    const baseTip = revParse(repo, "main");
    let threw: unknown;
    try {
      // inject a fake version probe simulating git 2.37
      await squashMergeLocal(repo, "feature/old", "main", async () => "git version 2.37.0");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("2.38");
    expect((threw as Error).message).toContain("2.37.0");
    // nothing moved
    expect(revParse(repo, "refs/heads/main")).toBe(baseTip);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── parseWorktrees annotations (locked/bare/prunable) ────────────────────────

test("parseWorktrees: bare AND reason-carrying locked/prunable both set the flag", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /tmp/wt-locked-bare",
    "HEAD def456",
    "detached",
    "locked", // bare form, no reason
    "",
    "worktree /tmp/wt-reason",
    "HEAD 789abc",
    "branch refs/heads/feat",
    "locked on another host", // reason-carrying form — MUST still set the flag
    "prunable gitdir file points to non-existent location", // reason-carrying
    "",
    "worktree /tmp/wt-bare",
    "bare",
    "",
  ].join("\n");
  const wts = parseWorktrees(porcelain);
  expect(wts).toHaveLength(4);

  // main worktree — every annotation false
  expect(wts[0]).toMatchObject({
    path: "/repo",
    branch: "main",
    detached: false,
    locked: false,
    bare: false,
    prunable: false,
  });
  // bare `locked` line
  expect(wts[1]).toMatchObject({ path: "/tmp/wt-locked-bare", detached: true, locked: true });
  // reason-carrying locked + prunable both flagged (the prefix-match guard)
  expect(wts[2]).toMatchObject({
    path: "/tmp/wt-reason",
    branch: "feat",
    locked: true,
    prunable: true,
  });
  // `bare` annotation
  expect(wts[3]).toMatchObject({ path: "/tmp/wt-bare", bare: true });
});

test("parseWorktrees: absent annotations default to false", () => {
  const wts = parseWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n");
  expect(wts).toHaveLength(1);
  expect(wts[0]).toMatchObject({ locked: false, bare: false, prunable: false, detached: false });
});
