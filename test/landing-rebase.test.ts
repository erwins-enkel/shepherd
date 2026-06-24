import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rebaseLandingBranch } from "../src/landing-rebase";
import type { LandingRebaseDeps } from "../src/landing-rebase";
import { WorktreeMgr } from "../src/worktree";

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: GIT_ENV }).toString().trim();
}

function commitFile(dir: string, file: string, content: string, msg: string) {
  const filePath = join(dir, file);
  const parts = file.split("/");
  if (parts.length > 1) {
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(filePath, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", msg]);
}

function revParse(dir: string, ref: string): string {
  return git(dir, ["rev-parse", ref]);
}

const REAL_SCRIPT = readFileSync(join(import.meta.dir, "..", "scripts", "json-union-merge.mjs"));
const REAL_REGISTER = readFileSync(
  join(import.meta.dir, "..", "scripts", "register-merge-driver.mjs"),
);

const GITATTRIBUTES =
  [
    "* text=auto eol=lf",
    "ui/messages/*.json merge=i18n-union",
    "extension/messages/*.json merge=i18n-union",
    "ui/src/lib/feature-announcements.ts merge=union",
  ].join("\n") + "\n";

/**
 * Build an origin (bare) + seed repo with a populated main branch.
 * The seed has scripts/ and .gitattributes committed.
 * The seed is returned so tests can add commits and branches before cloning.
 */
function setupBaseRepo(opts?: { broken?: boolean }): { origin: string; seed: string } {
  const origin = mkdtempSync(join(tmpdir(), "shepherd-lr-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });

  const seed = mkdtempSync(join(tmpdir(), "shepherd-lr-seed-"));
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "pipe" });

  writeFileSync(join(seed, ".gitattributes"), GITATTRIBUTES);

  mkdirSync(join(seed, "scripts"), { recursive: true });
  if (opts?.broken) {
    // Commit a broken driver script so the worktree checkout also has it
    writeFileSync(
      join(seed, "scripts", "json-union-merge.mjs"),
      `#!/usr/bin/env node\nprocess.exit(1);\n`,
    );
    writeFileSync(join(seed, "scripts", "register-merge-driver.mjs"), REAL_REGISTER);
  } else {
    writeFileSync(join(seed, "scripts", "json-union-merge.mjs"), REAL_SCRIPT);
    writeFileSync(join(seed, "scripts", "register-merge-driver.mjs"), REAL_REGISTER);
  }

  commitFile(seed, "a.txt", "base content\n", "init");
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: seed, stdio: "pipe" });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  return { origin, seed };
}

/**
 * Clone origin into a repo (single-branch main).
 */
function cloneRepo(origin: string): string {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-lr-clone-"));
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "main", origin, repo], {
    stdio: "pipe",
  });
  return repo;
}

/**
 * Register the i18n-union driver in a repo using the real/existing script.
 */
function registerDriverIn(repoPath: string): void {
  execFileSync("node", ["scripts/register-merge-driver.mjs"], {
    cwd: repoPath,
    stdio: "pipe",
  });
}

/**
 * Fetch with explicit refspecs so single-branch clones get tracking refs.
 * Uses `+` (forced) so re-fetches after a force-push also update the local ref.
 */
function fetchWithRefspec(repo: string, ...branches: string[]): void {
  const refspecs = branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  execFileSync("git", ["fetch", "origin", ...refspecs], { cwd: repo, stdio: "pipe" });
}

// ── teardown tracking ─────────────────────────────────────────────────────────

let toCleanup: string[] = [];

beforeEach(() => {
  toCleanup = [];
});

afterEach(() => {
  for (const p of toCleanup) {
    rmSync(p, { recursive: true, force: true });
  }
});

function track<T extends string>(...paths: T[]): T {
  toCleanup.push(...paths);
  return paths[0]!;
}

// ── async git dep ──────────────────────────────────────────────────────────

function makeGit(): LandingRebaseDeps["git"] {
  return (cwd, args) =>
    execFileAsync("git", args, { cwd, env: GIT_ENV }).then(({ stdout }) => ({ stdout }));
}

// ── TEST: rebased — default advanced, integration has own commit ──────────────

test("rebased: returns rebased + force-pushes when integration branch is behind default", async () => {
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Create an integration branch on top of main
  const intBranch = "epic/1-test";
  git(seed, ["checkout", "-qb", intBranch]);
  commitFile(seed, "epic.txt", "epic work\n", "epic: add feature");
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });
  const intBranchSha = revParse(seed, "HEAD");

  // Advance main on origin (after the integration branch was cut)
  git(seed, ["checkout", "-q", "main"]);
  commitFile(seed, "main-advance.txt", "new main work\n", "chore: advance main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });

  expect(result.kind).toBe("rebased");
  if (result.kind !== "rebased") return;

  // Verify force-push landed: fetch with explicit refspec so tracking ref updates
  fetchWithRefspec(repo, intBranch, "main");
  const newSha = revParse(repo, `origin/${intBranch}`);
  expect(newSha).toBe(result.headSha);
  expect(newSha).not.toBe(intBranchSha);

  // origin/main should be an ancestor of the newly rebased integration branch
  execFileSync("git", ["merge-base", "--is-ancestor", `origin/main`, `origin/${intBranch}`], {
    cwd: repo,
    stdio: "pipe",
  });
  // If the above didn't throw, origin/main IS an ancestor of the rebased branch
});

// ── TEST: current — integration already contains default ────────────────────

test("current: returns current when integration branch already contains default", async () => {
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Create integration branch on latest main (it already contains main)
  const intBranch = "epic/2-current";
  git(seed, ["checkout", "-qb", intBranch]);
  commitFile(seed, "epic2.txt", "epic 2\n", "feat: epic 2");
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });
  // main did NOT advance after the integration branch was cut
  // so integration branch ALREADY contains main

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });

  expect(result.kind).toBe("current");
});

// ── TEST: union false-conflict auto-resolves; apply backend would conflict ───

test("append-only union conflict auto-resolves with pinned merge backend", async () => {
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Establish a base messages state and push to main
  const baseMessages = JSON.stringify({ shared_key: "hello" }, null, 2) + "\n";
  commitFile(seed, "ui/messages/en.json", baseMessages, "chore: add base messages");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  // Create integration branch: adds epic_key
  const intBranch = "epic/3-union";
  git(seed, ["checkout", "-qb", intBranch]);
  const epicMessages =
    JSON.stringify({ shared_key: "hello", epic_key: "epic value" }, null, 2) + "\n";
  writeFileSync(join(seed, "ui", "messages", "en.json"), epicMessages);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: add epic_key"]);
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });

  // Advance main: adds main_key (different key — would line-conflict without union driver)
  git(seed, ["checkout", "-q", "main"]);
  const mainMessages =
    JSON.stringify({ shared_key: "hello", main_key: "main value" }, null, 2) + "\n";
  writeFileSync(join(seed, "ui", "messages", "en.json"), mainMessages);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: add main_key on default"]);
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  // With the pinned merge backend + union driver, this should auto-resolve
  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });

  expect(result.kind).toBe("rebased");

  // ── Demonstrate that WITHOUT the driver, the same rebase would conflict ──────
  // This shows why the driver is load-bearing for the union-managed files.
  // The `apply` backend behavior re: merge drivers is git-version-dependent
  // (git ≥ 2.34 may invoke the driver on its 3-way fallback too), so we
  // demonstrate driver necessity by using NO driver registration instead.
  const noDriverOrigin = mkdtempSync(join(tmpdir(), "shepherd-lr-nodrv-origin-"));
  track(noDriverOrigin);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", noDriverOrigin], { stdio: "pipe" });

  const noDriverSeed = mkdtempSync(join(tmpdir(), "shepherd-lr-nodrv-seed-"));
  track(noDriverSeed);
  execFileSync("git", ["init", "-q", "-b", "main", noDriverSeed], { stdio: "pipe" });
  writeFileSync(join(noDriverSeed, ".gitattributes"), GITATTRIBUTES);
  mkdirSync(join(noDriverSeed, "scripts"), { recursive: true });
  // Put a script file that exits non-zero so driver can't resolve
  writeFileSync(
    join(noDriverSeed, "scripts", "json-union-merge.mjs"),
    `#!/usr/bin/env node\nprocess.exit(1);\n`,
  );
  writeFileSync(join(noDriverSeed, "scripts", "register-merge-driver.mjs"), REAL_REGISTER);
  commitFile(noDriverSeed, "ui/messages/en.json", baseMessages, "init");
  execFileSync("git", ["remote", "add", "origin", noDriverOrigin], {
    cwd: noDriverSeed,
    stdio: "pipe",
  });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: noDriverSeed, stdio: "pipe" });

  // Integration branch adds epic_key
  git(noDriverSeed, ["checkout", "-qb", "epic/nodrv-test"]);
  writeFileSync(join(noDriverSeed, "ui", "messages", "en.json"), epicMessages);
  git(noDriverSeed, ["add", "-A"]);
  git(noDriverSeed, ["commit", "-qm", "feat: epic key"]);
  execFileSync("git", ["push", "-q", "origin", "epic/nodrv-test"], {
    cwd: noDriverSeed,
    stdio: "pipe",
  });

  // Main adds main_key
  git(noDriverSeed, ["checkout", "-q", "main"]);
  writeFileSync(join(noDriverSeed, "ui", "messages", "en.json"), mainMessages);
  git(noDriverSeed, ["add", "-A"]);
  git(noDriverSeed, ["commit", "-qm", "feat: main key"]);
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: noDriverSeed, stdio: "pipe" });

  const noDriverRepo = mkdtempSync(join(tmpdir(), "shepherd-lr-nodrv-repo-"));
  track(noDriverRepo);
  execFileSync(
    "git",
    ["clone", "-q", "--single-branch", "--branch", "main", noDriverOrigin, noDriverRepo],
    { stdio: "pipe" },
  );
  // Register the BROKEN driver so it's registered but non-functional
  registerDriverIn(noDriverRepo);

  // The rebaseLandingBranch with the broken driver should return driver-broken
  // (not rebased), showing the driver is load-bearing for union file resolution
  const noDrvWt = new WorktreeMgr();
  const noDrvResult = await rebaseLandingBranch(noDriverRepo, "epic/nodrv-test", "main", {
    worktrees: noDrvWt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });
  // With a broken driver, the union conflict can't be resolved
  expect(noDrvResult.kind).toBe("driver-broken");
});

// ── TEST: conflict — non-union path ──────────────────────────────────────────

test("conflict: returns conflict when a non-union file has a real conflict", async () => {
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Create integration branch that edits a.txt
  const intBranch = "epic/4-conflict";
  git(seed, ["checkout", "-qb", intBranch]);
  writeFileSync(join(seed, "a.txt"), "epic edit\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: edit a.txt in integration"]);
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });

  // Advance main with a conflicting edit to a.txt
  git(seed, ["checkout", "-q", "main"]);
  writeFileSync(join(seed, "a.txt"), "main edit\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "chore: edit a.txt on main"]);
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });

  expect(result.kind).toBe("conflict");
});

// ── TEST: conflict — union path, genuine same-key clash (self-test passes) ────

test("conflict: returns conflict on a genuine same-key clash in a union catalog", async () => {
  // Both branches set the SAME key to DIFFERENT values in a merge=i18n-union file.
  // The real union driver exits non-zero on a same-key clash (so the union path
  // conflicts), but the additive self-test (a/b/c) still passes — so the result
  // must be `conflict` (genuine clash), NOT `driver-broken`.
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Base catalog with a shared key
  const baseMessages = JSON.stringify({ shared_key: "base value" }, null, 2) + "\n";
  commitFile(seed, "ui/messages/en.json", baseMessages, "chore: add base messages");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  // Integration branch changes shared_key to one value
  const intBranch = "epic/8-samekey";
  git(seed, ["checkout", "-qb", intBranch]);
  writeFileSync(
    join(seed, "ui", "messages", "en.json"),
    JSON.stringify({ shared_key: "epic value" }, null, 2) + "\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: change shared_key on integration"]);
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });

  // Main changes the SAME key to a DIFFERENT value → genuine same-key clash
  git(seed, ["checkout", "-q", "main"]);
  writeFileSync(
    join(seed, "ui", "messages", "en.json"),
    JSON.stringify({ shared_key: "main value" }, null, 2) + "\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: change shared_key on default"]);
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });

  // Working driver + same-key clash → genuine conflict, NOT driver-broken
  expect(result.kind).toBe("conflict");
});

// ── TEST: driver-broken — union-only conflict + self-test fails ───────────────

test("driver-broken: returns driver-broken when union-only conflict + broken driver", async () => {
  // Use a setup where the seed has a BROKEN json-union-merge.mjs committed.
  // The worktree is a checkout of the integration branch, so it also gets the broken script.
  // The rebase will conflict on the JSON catalog (broken driver can't merge it),
  // and the self-test (which also runs the broken script from repoPath) will fail.
  const { origin, seed } = setupBaseRepo({ broken: true });
  track(origin, seed);

  // The seed has the broken script — we need to also ensure it's in the clone
  // (which is what `repoPath` will be). We clone before adding the broken script to
  // the work tree too, so we copy it over.
  const repo = track(cloneRepo(origin));
  // The broken script must live in BOTH places: committed on the branch (so the
  // worktree checkout runs it during the rebase → union file conflicts) AND in
  // repoPath/scripts (because driverSelfTest reads the script from repoPath, not
  // the worktree → self-test fails → driver-broken).
  writeFileSync(
    join(repo, "scripts", "json-union-merge.mjs"),
    `#!/usr/bin/env node\nprocess.exit(1);\n`,
  );
  // Register the driver (points to our broken script)
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Add a base messages file to seed/main
  const baseMessages = JSON.stringify({ shared_key: "hello" }, null, 2) + "\n";
  mkdirSync(join(seed, "ui", "messages"), { recursive: true });
  writeFileSync(join(seed, "ui", "messages", "en.json"), baseMessages);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "chore: add base messages"]);
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  // Integration branch: adds epic_key
  const intBranch = "epic/5-driver-broken";
  git(seed, ["checkout", "-qb", intBranch]);
  writeFileSync(
    join(seed, "ui", "messages", "en.json"),
    JSON.stringify({ shared_key: "hello", epic_key: "epic" }, null, 2) + "\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: add epic_key"]);
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });

  // Main: adds main_key (line-level conflict with integration on the JSON file)
  git(seed, ["checkout", "-q", "main"]);
  writeFileSync(
    join(seed, "ui", "messages", "en.json"),
    JSON.stringify({ shared_key: "hello", main_key: "main" }, null, 2) + "\n",
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "feat: add main_key"]);
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: registerDriverIn,
  });

  expect(result.kind).toBe("driver-broken");
});

// ── TEST: driver-absent — registerDriver is a no-op ─────────────────────────

test("driver-absent: returns driver-absent when registerDriver is a no-op", async () => {
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  // Do NOT register driver in repo — and inject a no-op registerDriver

  const wt = new WorktreeMgr();

  const intBranch = "epic/6-absent";
  git(seed, ["checkout", "-qb", intBranch]);
  commitFile(seed, "epic6.txt", "epic 6\n", "feat: epic 6");
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });

  // Advance main
  git(seed, ["checkout", "-q", "main"]);
  commitFile(seed, "main6.txt", "main 6\n", "chore: advance main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: makeGit(),
    registerDriver: () => {
      /* no-op — driver stays absent */
    },
  });

  expect(result.kind).toBe("driver-absent");
});

// ── TEST: transient — push fails (stale lease) ────────────────────────────────

test("transient: returns transient when push fails due to stale lease", async () => {
  const { origin, seed } = setupBaseRepo();
  track(origin, seed);
  const repo = track(cloneRepo(origin));
  registerDriverIn(repo);

  const wt = new WorktreeMgr();

  // Create integration branch
  const intBranch = "epic/7-transient";
  git(seed, ["checkout", "-qb", intBranch]);
  commitFile(seed, "epic7.txt", "epic 7\n", "feat: epic 7");
  execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });

  // Advance main
  git(seed, ["checkout", "-q", "main"]);
  commitFile(seed, "main7.txt", "main 7\n", "chore: advance main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });

  const originalGit = makeGit();

  // Intercept push to first advance origin/intBranch so the lease is stale
  const interceptGit: LandingRebaseDeps["git"] = async (cwd, args) => {
    if (args[0] === "push" && args.some((a) => a.includes("force-with-lease"))) {
      // Advance the integration branch on origin BEFORE the push to invalidate the lease
      git(seed, ["checkout", "-q", intBranch]);
      commitFile(seed, "race.txt", "concurrent\n", "concurrent: advance integration");
      execFileSync("git", ["push", "-q", "origin", intBranch], { cwd: seed, stdio: "pipe" });
    }
    return originalGit(cwd, args);
  };

  const result = await rebaseLandingBranch(repo, intBranch, "main", {
    worktrees: wt,
    git: interceptGit,
    registerDriver: registerDriverIn,
  });

  expect(result.kind).toBe("transient");
});

// ── TEST: invalid refname → transient ────────────────────────────────────────

test("transient: invalid integrationBranch refname returns transient", async () => {
  const result = await rebaseLandingBranch("/some/repo", "-evil-branch", "main");
  expect(result.kind).toBe("transient");
});

test("transient: invalid defaultBranch refname returns transient", async () => {
  const result = await rebaseLandingBranch("/some/repo", "epic/1-valid", "-evil");
  expect(result.kind).toBe("transient");
});
