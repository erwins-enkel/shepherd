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

// INVERTED from old behavior: checked-out branch IS now fast-forwarded when clean
test("ensureBaseRef: checked-out branch IS fast-forwarded when tree is clean", async () => {
  const wt = new WorktreeMgr();
  const before = revParse(repo, "main");

  // Advance origin/main so local main is behind
  const other = mkdtempSync(join(tmpdir(), "shepherd-other-"));
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
  commit(other, "a.txt", "advanced", "advance main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  const originTip = revParse(other, "main");
  rmSync(other, { recursive: true, force: true });

  const resolved = await wt.ensureBaseRef(repo, "main");
  // local main was fast-forwarded to origin tip
  expect(revParse(repo, "main")).toBe(originTip);
  expect(revParse(repo, "main")).not.toBe(before);
  expect(resolved.localFf).toBe("applied");
  expect(resolved.baseRef).toBe(originTip);
  expect(resolved.behind).toBeGreaterThan(0);
  expect(resolved.hasUpstream).toBe(true);
});

// Regression test: the payoff — worktree bases on upstream-only commit
test("ensureBaseRef + wt.create: worktree HEAD contains upstream-only commit", async () => {
  const wt = new WorktreeMgr();

  const other = mkdtempSync(join(tmpdir(), "shepherd-other-"));
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
  commit(other, "upstream-only.txt", "fresh", "upstream only commit");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  const originTip = revParse(other, "main");
  rmSync(other, { recursive: true, force: true });

  const resolved = await wt.ensureBaseRef(repo, "main");
  expect(resolved.localFf).toBe("applied");
  expect(resolved.baseRef).toBe(originTip);

  const r = wt.create(repo, resolved.baseRef, "child");
  expect(r.isolated).toBe(true);
  // The new worktree HEAD should be at the upstream tip
  expect(revParse(r.worktreePath, "HEAD")).toBe(originTip);
  wt.remove(r.worktreePath);
});

// origin-only branch is materialized and baseRef points to origin sha
test("ensureBaseRef: origin-only branch is materialized into a local branch", async () => {
  const wt = new WorktreeMgr();
  // epic/9-x exists on origin but NOT locally (single-branch clone of main)
  expect(localBranches(repo)).not.toContain("epic/9-x");

  const resolved = await wt.ensureBaseRef(repo, "epic/9-x");
  expect(resolved.localFf).toBe("applied");
  expect(resolved.hasUpstream).toBe(true);
  expect(resolved.baseRef).toMatch(/^[0-9a-f]{40}$/);
  expect(localBranches(repo)).toContain("epic/9-x");

  // wt.create on it is isolated
  const r = wt.create(repo, "epic/9-x", "child");
  expect(r.isolated).toBe(true);
  wt.remove(r.worktreePath);
});

// existing local non-checked-out branch is fast-forwarded
test("ensureBaseRef: existing local integration branch is fast-forwarded to origin tip", async () => {
  const wt = new WorktreeMgr();
  // C1: materialize local epic/9-x at origin's current tip.
  await wt.ensureBaseRef(repo, "epic/9-x");
  expect(localBranches(repo)).toContain("epic/9-x");
  const c1 = revParse(repo, "epic/9-x");

  // C2: a sibling advances origin/epic/9-x
  const other = mkdtempSync(join(tmpdir(), "shepherd-sibling-"));
  execFileSync("git", ["clone", "-q", "--branch", "epic/9-x", origin, other], { stdio: "pipe" });
  commit(other, "c.txt", "sibling work", "sibling merge");
  execFileSync("git", ["push", "-q", "origin", "epic/9-x"], { cwd: other, stdio: "pipe" });
  const c2 = revParse(other, "epic/9-x");
  rmSync(other, { recursive: true, force: true });
  expect(c2).not.toBe(c1); // origin genuinely advanced

  // Second spawn: local epic/9-x must fast-forward to C2
  const resolved = await wt.ensureBaseRef(repo, "epic/9-x");
  expect(resolved.localFf).toBe("applied");
  expect(resolved.baseRef).toBe(c2);
  expect(revParse(repo, "epic/9-x")).toBe(c2);
  expect(revParse(repo, "epic/9-x")).not.toBe(c1);
});

// diverged → keep local, warn
test("ensureBaseRef: diverged branch → localFf=skipped-diverged, local tip preserved", async () => {
  const wt = new WorktreeMgr();
  // Materialize epic/9-x locally
  await wt.ensureBaseRef(repo, "epic/9-x");

  // Advance local epic/9-x with a local-only commit
  execFileSync("git", ["checkout", "-q", "epic/9-x"], { cwd: repo, stdio: "pipe", env: GIT_ENV });
  commit(repo, "local-only.txt", "local only", "local commit on epic");
  const localTip = revParse(repo, "epic/9-x");
  // Return to main
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repo, stdio: "pipe", env: GIT_ENV });

  // Advance origin/epic/9-x independently
  const other = mkdtempSync(join(tmpdir(), "shepherd-diverge-"));
  execFileSync("git", ["clone", "-q", "--branch", "epic/9-x", origin, other], { stdio: "pipe" });
  commit(other, "origin-only.txt", "origin only", "origin commit on epic");
  execFileSync("git", ["push", "-q", "origin", "epic/9-x"], { cwd: other, stdio: "pipe" });
  rmSync(other, { recursive: true, force: true });

  const resolved = await wt.ensureBaseRef(repo, "epic/9-x");
  expect(resolved.diverged).toBe(true);
  expect(resolved.localFf).toBe("skipped-diverged");
  // baseRef is the branch name (not origin sha) for diverged case
  expect(resolved.baseRef).toBe("epic/9-x");
  // local tip is unchanged
  expect(revParse(repo, "epic/9-x")).toBe(localTip);
});

// dirty checked-out tree → skip ff, but still get fresh baseRef
test("ensureBaseRef: dirty checked-out tree → localFf=skipped-dirty, baseRef still fresh", async () => {
  const wt = new WorktreeMgr();
  const localTip = revParse(repo, "main");

  // Advance origin/main
  const other = mkdtempSync(join(tmpdir(), "shepherd-dirty-"));
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
  commit(other, "a.txt", "origin advanced", "advance origin main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  const originTip = revParse(other, "main");
  rmSync(other, { recursive: true, force: true });

  // Write an uncommitted change to make the tree dirty
  writeFileSync(join(repo, "dirty.txt"), "uncommitted change");

  const resolved = await wt.ensureBaseRef(repo, "main");
  expect(resolved.localFf).toBe("skipped-dirty");
  // local main tip is unchanged
  expect(revParse(repo, "main")).toBe(localTip);
  // but baseRef is still the origin sha — new task starts fresh
  expect(resolved.baseRef).toBe(originTip);
  expect(resolved.hasUpstream).toBe(true);
});

// checked-out in another worktree → skipped-checked-out-elsewhere
test("ensureBaseRef: branch checked out in another worktree → skipped-checked-out-elsewhere", async () => {
  const wt = new WorktreeMgr();

  // Create a local branch "feature" and push it
  execFileSync("git", ["checkout", "-q", "-b", "feature"], {
    cwd: repo,
    stdio: "pipe",
    env: GIT_ENV,
  });
  commit(repo, "feat.txt", "feature start", "start feature");
  execFileSync("git", ["push", "-q", "-u", "origin", "feature"], { cwd: repo, stdio: "pipe" });
  const featureTip = revParse(repo, "feature");
  // Return to main
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repo, stdio: "pipe", env: GIT_ENV });

  // Add a worktree that checks out "feature" elsewhere
  const extraWt = join(tmpdir(), "shepherd-extra-wt-" + Date.now());
  execFileSync("git", ["worktree", "add", extraWt, "feature"], { cwd: repo, stdio: "pipe" });

  try {
    // Advance origin/feature from a sibling clone
    const other = mkdtempSync(join(tmpdir(), "shepherd-sibling-feat-"));
    execFileSync("git", ["clone", "-q", "--branch", "feature", origin, other], { stdio: "pipe" });
    commit(other, "feat.txt", "more feature", "advance feature on origin");
    execFileSync("git", ["push", "-q", "origin", "feature"], { cwd: other, stdio: "pipe" });
    const originFeatureTip = revParse(other, "feature");
    rmSync(other, { recursive: true, force: true });

    const resolved = await wt.ensureBaseRef(repo, "feature");
    expect(resolved.localFf).toBe("skipped-checked-out-elsewhere");
    // local feature tip is unchanged
    expect(revParse(repo, "feature")).toBe(featureTip);
    // baseRef is still the origin sha (task starts fresh)
    expect(resolved.baseRef).toBe(originFeatureTip);
  } finally {
    // Clean up the extra worktree
    execFileSync("git", ["worktree", "remove", "--force", extraWt], { cwd: repo, stdio: "pipe" });
  }
});

// up to date → not-needed
test("ensureBaseRef: already up to date → localFf=not-needed, behind=0", async () => {
  const wt = new WorktreeMgr();
  // Materialize epic/9-x locally (already at origin tip)
  await wt.ensureBaseRef(repo, "epic/9-x");
  const tip = revParse(repo, "epic/9-x");

  // Run again — origin hasn't advanced, so no ff needed
  const resolved = await wt.ensureBaseRef(repo, "epic/9-x");
  expect(resolved.localFf).toBe("not-needed");
  expect(resolved.behind).toBe(0);
  expect(resolved.hasUpstream).toBe(true);
  expect(resolved.localExists).toBe(true);
  expect(revParse(repo, "epic/9-x")).toBe(tip);
});

// invalid base name → fail-closed, no throw
test("ensureBaseRef: invalid base name is ignored (no throw, no branch)", async () => {
  const wt = new WorktreeMgr();
  const resolved = await wt.ensureBaseRef(repo, "--evil");
  expect(resolved.baseRef).toBe("--evil");
  expect(resolved.behind).toBe(0);
  expect(resolved.ahead).toBe(0);
  expect(resolved.diverged).toBe(false);
  expect(resolved.hasUpstream).toBe(false);
  expect(resolved.localExists).toBe(false);
  expect(resolved.localFf).toBe("none");
  expect(localBranches(repo)).toEqual(["main"]);
});
