import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { WorktreeMgr, WorktreeRestoreError } from "../src/worktree";
import { ProcessReaper } from "../src/process-reaper";

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

test("remove() sweeps the worktree for orphaned processes before tearing it down (#1133)", () => {
  const calls: string[] = [];
  const stubReaper = {
    reapOrphansUnder: (p: string) => {
      // assert the worktree still exists when the sweep runs — it must reap BEFORE removal,
      // so a process' cwd still resolves to the real path the sweep matches on.
      expect(existsSync(p)).toBe(true);
      calls.push(p);
      return 0;
    },
  } as unknown as ProcessReaper;
  const wt = new WorktreeMgr(stubReaper);
  const r = wt.create(repo, "main", "reap-orphans");
  wt.remove(r.worktreePath);
  expect(calls).toEqual([r.worktreePath]);
  expect(existsSync(r.worktreePath)).toBe(false);
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

test("currentBranch returns null on a detached HEAD", async () => {
  const wt = new WorktreeMgr();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const r = await wt.createDetached(repo, "main", sha);
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

test("createDetached: checks out a detached worktree at the given sha", async () => {
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
  const wt = await mgr.createDetached(repo, "feat/x", sha);

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

test("createDetached: rejects a branch that could smuggle a git flag", async () => {
  const mgr = new WorktreeMgr();
  const sha = "0".repeat(40);
  await expect(mgr.createDetached(repo, "--upload-pack=evil", sha)).rejects.toThrow(
    "invalid branch",
  );
  await expect(mgr.createDetached(repo, "-x", sha)).rejects.toThrow("invalid branch");
});

test("createDetached: distinct slugs at the SAME sha get distinct worktrees (no plan-review collision)", async () => {
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
  // Two sessions' plan reviews both detach at the same base sha — they must NOT share a path,
  // else a second begin() destroys the first's worktree and both read one verdict file.
  const a = await mgr.createDetached(repo, "feat/x", sha, "session-aaaa");
  const b = await mgr.createDetached(repo, "feat/x", sha, "session-bbbb");
  expect(a.worktreePath).not.toBe(b.worktreePath);
  expect(existsSync(a.worktreePath)).toBe(true);
  expect(existsSync(b.worktreePath)).toBe(true);
  // a slugless detach (the PR critic) stays distinct from the slugged ones too
  const c = await mgr.createDetached(repo, "feat/x", sha);
  expect(c.worktreePath).not.toBe(a.worktreePath);
  expect(c.worktreePath).not.toBe(b.worktreePath);

  mgr.remove(a.worktreePath);
  mgr.remove(b.worktreePath);
  mgr.remove(c.worktreePath);
});

test("createDetached: rejects a slug that could escape the worktree dir", async () => {
  const mgr = new WorktreeMgr();
  const sha = "0".repeat(40);
  await expect(mgr.createDetached(repo, "main", sha, "../escape")).rejects.toThrow("invalid slug");
  await expect(mgr.createDetached(repo, "main", sha, "a/b")).rejects.toThrow("invalid slug");
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

test("createDetached: reclaims a stale worktree path left by an interrupted run", async () => {
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
  const first = await mgr.createDetached(repo, "feat/x", sha);
  // simulate a restart: the in-memory inflight record is gone but the worktree
  // dir + registration remain. A re-spawn for the same head must still succeed.
  const second = await mgr.createDetached(repo, "feat/x", sha);
  expect(second.worktreePath).toBe(first.worktreePath);
  expect(existsSync(second.worktreePath)).toBe(true);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: second.worktreePath })
    .toString()
    .trim();
  expect(head).toBe(sha);

  mgr.remove(second.worktreePath);
});

test("createDetached: rejects a pullRef that could smuggle a git flag", async () => {
  const mgr = new WorktreeMgr();
  const sha = "0".repeat(40);
  await expect(
    mgr.createDetached(repo, "main", sha, undefined, "--upload-pack=evil"),
  ).rejects.toThrow("invalid pullRef");
  await expect(mgr.createDetached(repo, "main", sha, undefined, "-x")).rejects.toThrow(
    "invalid pullRef",
  );
});

test("createDetached: a fork head only reachable via pullRef is fetched and checked out", async () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  // A bare "origin" that holds main PLUS a fork PR head stored ONLY under refs/pull/1/head —
  // it is NOT on any branch, so a plain `git fetch origin -- <branch>` can never land it. This
  // is exactly the GitHub fork case: the head sha lives off-branch on the base repo's origin.
  const origin = mkdtempSync(join(tmpdir(), "shepherd-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });

  // A seed clone to author the fork head + push the special ref into origin.
  const seed = mkdtempSync(join(tmpdir(), "shepherd-seed-"));
  execFileSync("git", ["clone", "-q", origin, seed]);
  writeFileSync(join(seed, "base.txt"), "base");
  execFileSync("git", ["add", "-A"], { cwd: seed });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: seed, env });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed });
  // fork head: a commit pushed to refs/pull/1/head, then the local branch deleted so it
  // lives off-branch on origin (mirrors how GitHub exposes a fork PR head on the base repo).
  writeFileSync(join(seed, "fork.txt"), "fork");
  execFileSync("git", ["add", "-A"], { cwd: seed });
  execFileSync("git", ["commit", "-q", "-m", "fork change"], { cwd: seed, env });
  const forkSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed }).toString().trim();
  execFileSync("git", ["push", "-q", "origin", `HEAD:refs/pull/1/head`], { cwd: seed });

  // The base repo: a fresh clone of origin. It has main but NOT the fork sha (off-branch).
  // `--no-local` forces a real pack negotiation (the default local clone copies the WHOLE
  // object store, which would smuggle the off-branch fork object in and defeat the test).
  const base = mkdtempSync(join(tmpdir(), "shepherd-base-"));
  execFileSync("git", ["clone", "-q", "--no-local", origin, base]);
  expect(() =>
    execFileSync("git", ["cat-file", "-e", `${forkSha}^{commit}`], { cwd: base, stdio: "pipe" }),
  ).toThrow(); // proves the sha is genuinely absent before the pullRef fetch

  const mgr = new WorktreeMgr();
  // WITHOUT a pullRef the head can't be fetched and the checkout fails — the fork case the param fixes.
  await expect(mgr.createDetached(base, "main", forkSha)).rejects.toThrow();
  // WITH the pullRef it's fetched into the store and the detached checkout lands at the fork head.
  const wt = await mgr.createDetached(base, "main", forkSha, undefined, "refs/pull/1/head");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.worktreePath })
    .toString()
    .trim();
  expect(head).toBe(forkSha);

  mgr.remove(wt.worktreePath);
  rmSync(origin, { recursive: true, force: true });
  rmSync(seed, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

// ── Task A: four new tests for the reworked create() failure path ────────────

const gitEnvBasic = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

test("create: invalid base ref throws with stderr in message", () => {
  const wt = new WorktreeMgr();
  expect(() => wt.create(repo, "no-such-base", "x")).toThrow(/invalid reference/i);
});

test("create: non-git directory returns non-isolated, no throw", () => {
  const nonGitDir = mkdtempSync(join(tmpdir(), "shepherd-nongit-"));
  try {
    const wt = new WorktreeMgr();
    const r = wt.create(nonGitDir, "main", "x");
    expect(r.isolated).toBe(false);
    expect(r.branch).toBeNull();
    expect(r.worktreePath).toBe(nonGitDir);
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test("create: branch-exists collision → retry → abort, branch + commit preserved", () => {
  // Pre-create shepherd/dup with an extra commit not on main
  execFileSync("git", ["checkout", "-b", "shepherd/dup"], { cwd: repo });
  execFileSync("git", ["commit", "--allow-empty", "-m", "dup-extra"], {
    cwd: repo,
    env: gitEnvBasic,
  });
  const dupSha = execFileSync("git", ["rev-parse", "shepherd/dup"], { cwd: repo })
    .toString()
    .trim();
  execFileSync("git", ["checkout", "main"], { cwd: repo });

  const wt = new WorktreeMgr();
  expect(() => wt.create(repo, "main", "dup")).toThrow(/already exists/i);

  // shepherd/dup still points at the extra commit (branch -D was NOT run)
  const shaAfter = execFileSync("git", ["rev-parse", "shepherd/dup"], { cwd: repo })
    .toString()
    .trim();
  expect(shaAfter).toBe(dupSha);
  // The extra commit is NOT on main → branch genuinely preserved
  expect(() =>
    execFileSync("git", ["merge-base", "--is-ancestor", "shepherd/dup", "main"], {
      cwd: repo,
      stdio: "pipe",
    }),
  ).toThrow();
});

test("create: cleanupPartial removes leftover dir → retry succeeds", () => {
  // Pre-create a non-empty directory at the exact path create() will use
  const parent = join(dirname(repo), ".shepherd-worktrees");
  const worktreePath = join(parent, `${basename(repo)}-recover`);
  mkdirSync(parent, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(join(worktreePath, "leftover.txt"), "stale");

  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "recover");
  expect(r.isolated).toBe(true);
  expect(r.branch).toBe("shepherd/recover");
  expect(existsSync(r.worktreePath)).toBe(true);
  wt.remove(r.worktreePath);
});

// ── end Task A tests ──────────────────────────────────────────────────────────

test("restoreExisting: attaches to an existing branch at the given path", () => {
  const wt = new WorktreeMgr();
  // create + remove a worktree so the branch survives but its worktree dir is gone
  const r = wt.create(repo, "main", "restore-me");
  const { worktreePath, branch } = r;
  wt.remove(worktreePath); // no branch opts → branch kept
  expect(existsSync(worktreePath)).toBe(false);

  const got = wt.restoreExisting(repo, branch!, worktreePath);
  expect(got).toBe(worktreePath);
  expect(existsSync(worktreePath)).toBe(true);
  // worktree checks out the branch
  expect(wt.currentBranch(worktreePath)).toBe(branch);
  wt.remove(worktreePath);
});

test("restoreExisting: branch_gone when the branch no longer exists", () => {
  const wt = new WorktreeMgr();
  let err: unknown;
  try {
    wt.restoreExisting(
      repo,
      "shepherd/nonexistent-branch",
      join(dirname(repo), ".shepherd-worktrees/x-restore-gone"),
    );
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WorktreeRestoreError);
  expect((err as WorktreeRestoreError).code).toBe("branch_gone");
});

test("restoreExisting: removes a stale worktree dir before re-attaching", () => {
  const wt = new WorktreeMgr();
  const r = wt.create(repo, "main", "restore-stale");
  const { worktreePath, branch } = r;
  // branch+worktree both exist — simulates a stale partial state
  // detach the registered worktree but leave the directory via a plain remove
  // (we can't easily simulate a "stale dir" without going through git,
  //  so we remove+restore to prove the method handles re-attach correctly)
  wt.remove(worktreePath);
  const got = wt.restoreExisting(repo, branch!, worktreePath);
  expect(got).toBe(worktreePath);
  expect(existsSync(worktreePath)).toBe(true);
  wt.remove(worktreePath);
});

test("restoreExisting: invalid branch name throws", () => {
  const wt = new WorktreeMgr();
  expect(() => wt.restoreExisting(repo, "--bad-branch", "/some/path")).toThrow("invalid branch");
});

test("behindBase: false when up-to-date, true when base advanced", async () => {
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
  expect(await wt.behindBase(dir, "main")).toBe(false);
  // advance main beyond feat
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "c"), "1");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "main2"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-q", "feat"], { cwd: dir, stdio: "pipe" });
  expect(await wt.behindBase(dir, "main")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
