/**
 * Regression tests for audit F01/F02/F05/F07: server-side git over agent- or PR-controlled repo
 * state must never run that state's code. Every test plants a marker-writing script where git
 * WOULD execute it unhardened, runs the real server code path, and asserts the marker is empty.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeDiff } from "../src/diff";
import { defaultComputePatchId } from "../src/critic-core";
import { rebaseLandingBranch } from "../src/landing-rebase";
import { fastForwardDefaultBranch } from "../src/pull";
import { SessionArchiver } from "../src/session-archiver";
import type { Session } from "../src/types";
import { WorktreeMgr } from "../src/worktree";
import {
  advanceOrigin,
  g,
  makeFixture,
  markerLines,
  plantScript,
  type Fixture,
} from "./helpers/git-fixture";

let f: Fixture | null = null;
afterEach(() => {
  if (f) rmSync(f.root, { recursive: true, force: true });
  f = null;
});

/** An isolated session worktree on `task` with one commit, origin/main advanced past it. */
function sessionWorktree(fx: Fixture): string {
  const wt = join(fx.root, "wt");
  g(fx.repo, "worktree", "add", "-q", "-b", "task", wt, "main");
  writeFileSync(join(wt, "work.txt"), "work\n");
  g(wt, "add", "work.txt");
  g(wt, "commit", "-q", "-m", "work");
  advanceOrigin(fx);
  return wt;
}

test("F01 A: worktree-local hook under the relative hooksPath does not run on computeDiff", async () => {
  f = makeFixture();
  const wt = sessionWorktree(f);
  for (const hook of ["reference-transaction", "post-index-change", "post-checkout"]) {
    plantScript(join(wt, ".husky", "_", hook), f.marker, hook);
  }
  const diff = await computeDiff(wt, "main", "task", f.repo);
  expect(diff.fetchFailed).toBe(false);
  expect(diff.files.map((x) => x.path)).toEqual(["work.txt"]);
  expect(markerLines(f.marker)).toEqual([]);
});

test("F01 C: a repointed worktree .git gitfile is ignored (no foreign fsmonitor)", async () => {
  f = makeFixture();
  const wt = sessionWorktree(f);
  const evil = join(f.root, "evil");
  g(f.root, "clone", "-q", f.origin, evil);
  plantScript(join(f.root, "fsmon.sh"), f.marker, "FSMON");
  g(evil, "config", "core.fsmonitor", join(f.root, "fsmon.sh"));
  writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, ".git")}\n`);
  const diff = await computeDiff(wt, "main", "task", f.repo);
  expect(diff.files.map((x) => x.path)).toEqual(["work.txt"]);
  expect(markerLines(f.marker)).toEqual([]);
});

test("diff.external in agent-writable config does not run on computeDiff", async () => {
  f = makeFixture();
  const wt = sessionWorktree(f);
  plantScript(join(f.root, "extdiff.sh"), f.marker, "EXTDIFF");
  g(f.repo, "config", "diff.external", join(f.root, "extdiff.sh"));
  await computeDiff(wt, "main", "task", f.repo);
  expect(markerLines(f.marker)).toEqual([]);
});

test("an ext:: origin in agent-writable config does not run on behindBase", async () => {
  f = makeFixture();
  const wt = sessionWorktree(f);
  g(f.repo, "config", "protocol.ext.allow", "always");
  plantScript(join(f.root, "ext.sh"), f.marker, "EXT");
  g(f.repo, "remote", "set-url", "origin", `ext::${join(f.root, "ext.sh")}`);
  await new WorktreeMgr().behindBase(wt, "main", f.repo);
  expect(markerLines(f.marker)).toEqual([]);
});

test("F05: common-dir hooks + fsmonitor do not run on create / pull / archive", async () => {
  f = makeFixture();
  const hooks = join(f.root, "evil-hooks");
  for (const hook of ["post-checkout", "reference-transaction", "post-merge"]) {
    plantScript(join(hooks, hook), f.marker, hook);
  }
  plantScript(join(f.repo, ".git", "hooks", "post-checkout"), f.marker, "git-hooks-post-checkout");
  g(f.repo, "config", "core.hooksPath", hooks);
  plantScript(join(f.root, "fsmon.sh"), f.marker, "FSMON");
  g(f.repo, "config", "core.fsmonitor", join(f.root, "fsmon.sh"));

  const r = new WorktreeMgr().create(f.repo, "main", "next-session");
  expect(r.isolated).toBe(true);
  advanceOrigin(f);
  const pulled = await fastForwardDefaultBranch(f.repo, "main");
  expect(pulled.ok).toBe(true);

  const archiver = new SessionArchiver({} as never) as unknown as {
    hasUnsyncedWork(s: Session): Promise<boolean>;
  };
  writeFileSync(join(r.worktreePath, "dirty.txt"), "x\n");
  const s = {
    isolated: true,
    branch: r.branch,
    repoPath: f.repo,
    worktreePath: r.worktreePath,
  } as Session;
  expect(await archiver.hasUnsyncedWork(s)).toBe(true);
  expect(markerLines(f.marker)).toEqual([]);
});

test("F07: PR-head hooks do not run on createDetached + defaultComputePatchId", async () => {
  f = makeFixture();
  const fork = join(f.root, "fork");
  g(f.root, "clone", "-q", f.origin, fork);
  for (const hook of ["reference-transaction", "post-index-change", "post-checkout"]) {
    plantScript(join(fork, ".husky", "_", hook), f.marker, `PRHOOK ${hook}`);
  }
  writeFileSync(join(fork, "feature.txt"), "feature\n");
  g(fork, "add", "-f", ".husky/_", "feature.txt");
  g(fork, "commit", "-q", "-m", "attacker");
  const sha = g(fork, "rev-parse", "HEAD");
  g(fork, "push", "-q", "origin", "HEAD:refs/pull/1/head");
  advanceOrigin(f);

  const mgr = new WorktreeMgr();
  const wt = await mgr.createDetached(f.repo, "attacker", sha, "slug", "refs/pull/1/head");
  try {
    const res = await defaultComputePatchId(wt.worktreePath, "main", f.repo);
    expect(res.patchId).not.toBeNull();
    expect(res.files).toContain("feature.txt");
  } finally {
    mgr.remove(wt.worktreePath);
  }
  expect(markerLines(f.marker)).toEqual([]);
});

const CATALOG = "ui/messages/en.json";

function writeCatalog(dir: string, entries: Record<string, string>): void {
  mkdirSync(join(dir, "ui", "messages"), { recursive: true });
  writeFileSync(join(dir, CATALOG), `${JSON.stringify(entries, null, 2)}\n`);
}

test("F02: landing rebase uses Shepherd's driver, never the branch's script or hooks", async () => {
  f = makeFixture();
  // Operator checkout: union attrs + the repo-relative driver registration husky's prepare writes.
  writeFileSync(join(f.repo, ".gitattributes"), "ui/messages/*.json merge=i18n-union\n");
  writeCatalog(f.repo, { a: "1" });
  g(f.repo, "add", ".gitattributes", CATALOG);
  g(f.repo, "commit", "-q", "-m", "catalog");
  g(f.repo, "push", "-q", "origin", "main");
  g(f.repo, "config", "merge.i18n-union.driver", "node scripts/json-union-merge.mjs %O %A %B %P");

  // Agent-authored integration branch: malicious driver + force-added hooks + a catalog key.
  const agent = join(f.root, "agent");
  g(f.root, "clone", "-q", f.origin, agent);
  g(agent, "checkout", "-q", "-b", "epic/1-x");
  mkdirSync(join(agent, "scripts"), { recursive: true });
  writeFileSync(
    join(agent, "scripts", "json-union-merge.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(f.marker)}, "DRIVER\\n");\nprocess.exit(1);\n`,
  );
  for (const hook of ["post-commit", "post-rewrite", "pre-push", "reference-transaction"]) {
    plantScript(join(agent, ".husky", "_", hook), f.marker, `HOOK ${hook}`);
  }
  writeCatalog(agent, { a: "1", c: "3" });
  g(agent, "add", "-f", ".husky/_", "scripts", CATALOG);
  g(agent, "commit", "-q", "-m", "child");
  g(agent, "push", "-q", "origin", "epic/1-x");

  // Default branch moves with a conflicting tail key.
  writeCatalog(f.repo, { a: "1", b: "2" });
  g(f.repo, "add", CATALOG);
  g(f.repo, "commit", "-q", "-m", "main key");
  g(f.repo, "push", "-q", "origin", "main");

  const res = await rebaseLandingBranch(f.repo, "epic/1-x", "main", { registerDriver: () => {} });
  expect(res.kind).toBe("rebased");
  expect(markerLines(f.marker)).toEqual([]);

  const check = join(f.root, "check");
  g(f.root, "clone", "-q", "-b", "epic/1-x", f.origin, check);
  expect(JSON.parse(readFileSync(join(check, CATALOG), "utf8"))).toEqual({
    a: "1",
    b: "2",
    c: "3",
  });
});
