// test/branch-pruner.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionStore } from "../src/store";
import { BranchPruner } from "../src/branch-pruner";
import type { GitForge, PrStatus } from "../src/forge/types";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: ENV, stdio: "pipe" }).toString();

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "shepherd-bp-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

function localBranches(repo: string): string[] {
  return git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ST = (state: PrStatus["state"]): PrStatus => ({
  state,
  checks: "none",
  deployConfigured: false,
});

function forge(byBranch: Record<string, PrStatus["state"]>): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    prStatus: async (b: string) => ST(byBranch[b] ?? "none"),
    openPr: async () => ST("none"),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
  } as unknown as GitForge;
}

const sessionOn = (repo: string, branch: string) => ({
  name: branch.replace("shepherd/", ""),
  prompt: "x",
  repoPath: repo,
  baseBranch: "main",
  branch,
  worktreePath: join(repo, "..", "wt"),
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
});

test("caps forge lookups per tick and drains the backlog across ticks", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/a");
  git(repo, "branch", "shepherd/b");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/a")).id);
  // maxChecksPerTick = 1 → at most one branch checked (and so deleted) per tick.
  const pruner = new BranchPruner(
    store,
    () => forge({ "shepherd/a": "merged", "shepherd/b": "merged" }),
    () => [],
    60 * 60 * 1000,
    1,
  );

  await pruner.tick();
  expect(localBranches(repo).filter((b) => b.startsWith("shepherd/")).length).toBe(1);

  await pruner.tick();
  expect(localBranches(repo).filter((b) => b.startsWith("shepherd/")).length).toBe(0);
  rmSync(repo, { recursive: true, force: true });
});

test("deletes a merged orphan branch, keeps open and none", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/merged");
  git(repo, "branch", "shepherd/open");
  git(repo, "branch", "shepherd/never-pr");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/merged")).id); // archived → repo is enumerated
  const pruner = new BranchPruner(store, () =>
    forge({ "shepherd/merged": "merged", "shepherd/open": "open" }),
  );

  await pruner.tick();

  const left = localBranches(repo);
  expect(left).not.toContain("shepherd/merged");
  expect(left).toContain("shepherd/open");
  expect(left).toContain("shepherd/never-pr");
  rmSync(repo, { recursive: true, force: true });
});

test("sweeps a repo present only via extraRepos (idle repo whose sessions were pruned)", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/merged");
  const store = new SessionStore(":memory:"); // no session row → store.list() is empty
  const pruner = new BranchPruner(
    store,
    () => forge({ "shepherd/merged": "merged" }),
    () => [repo], // durable source keeps the idle repo in scope
  );

  await pruner.tick();

  expect(localBranches(repo)).not.toContain("shepherd/merged");
  rmSync(repo, { recursive: true, force: true });
});

test("never deletes a checked-out branch, even when merged", async () => {
  const repo = mkRepo();
  const wt = join(repo, "..", `${Date.now()}-live`);
  git(repo, "worktree", "add", "-q", wt, "-b", "shepherd/live");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/x")).id);
  const pruner = new BranchPruner(store, () => forge({ "shepherd/live": "merged" }));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/live");
  git(repo, "worktree", "remove", "--force", wt);
  rmSync(repo, { recursive: true, force: true });
});

test("never deletes an active session's branch", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/active");
  const store = new SessionStore(":memory:");
  store.create(sessionOn(repo, "shepherd/active")); // active (not archived)
  const pruner = new BranchPruner(store, () => forge({ "shepherd/active": "merged" }));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/active");
  rmSync(repo, { recursive: true, force: true });
});

test('no-op when branchPruneEnabled is "0"', async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/merged");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/merged")).id);
  store.setSetting("branchPruneEnabled", "0");
  const pruner = new BranchPruner(store, () => forge({ "shepherd/merged": "merged" }));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/merged");
  rmSync(repo, { recursive: true, force: true });
});

test("keeps the branch when the forge errors or is absent", async () => {
  const repo = mkRepo();
  git(repo, "branch", "shepherd/err");
  git(repo, "branch", "shepherd/noforge");
  const store = new SessionStore(":memory:");
  store.archive(store.create(sessionOn(repo, "shepherd/err")).id);
  const throwing = {
    ...forge({}),
    prStatus: async () => {
      throw new Error("gh down");
    },
  } as GitForge;
  const pruner = new BranchPruner(store, (dir) => (dir === repo ? throwing : null));

  await pruner.tick();

  expect(localBranches(repo)).toContain("shepherd/err");

  const noForge = new BranchPruner(store, () => null);
  await noForge.tick();
  expect(localBranches(repo)).toContain("shepherd/noforge");
  rmSync(repo, { recursive: true, force: true });
});
