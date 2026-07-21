import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultPlanAnchorSha, defaultAnchorStaleness } from "../src/plan-gate";

/** A real repo with a real `origin`, because the whole point of these functions is WHICH commit
 *  git actually picks — stubbing git would test nothing. Mirrors the temp-repo pattern in
 *  critic-core.test.ts. Returns the "origin" (bare-ish upstream), the session worktree clone, and
 *  a `git` helper bound to the clone. */
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "shep-anchor-"));
  const upstream = join(root, "upstream");
  const clone = join(root, "clone");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, stdio: "pipe" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return new TextDecoder().decode(r.stdout).trim();
  };
  spawnSync("git", ["init", "-q", "-b", "main", upstream], { stdio: "pipe" });
  git(upstream, "config", "user.email", "t@t");
  git(upstream, "config", "user.name", "T");
  writeFileSync(join(upstream, "existing.ts"), "export const a = 1;\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "base");
  const branchPoint = git(upstream, "rev-parse", "HEAD");

  spawnSync("git", ["clone", "-q", upstream, clone], { stdio: "pipe" });
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "T");
  git(clone, "checkout", "-q", "-b", "feature");

  return { root, upstream, clone, git, branchPoint };
}

test("anchor: merge-base wins, and is IDENTICAL whether or not the planner has committed", () => {
  const { root, clone, git, branchPoint } = scaffold();
  try {
    // planner has committed nothing yet
    const clean = defaultPlanAnchorSha(clone, "main", clone);
    expect(clean).toEqual({ sha: branchPoint, anchored: true, ahead: 0 });

    // planner commits code mid-gate — advanceToExecutionOnPr exists because this really happens
    writeFileSync(join(clone, "scaffolding.ts"), "export const b = 2;\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "planner scaffolding");
    const dirty = defaultPlanAnchorSha(clone, "main", clone);

    // Same anchor — this is why merge-base beats raw HEAD: the reviewer's tree does not swing
    // under it as the planner works, so round N+1 anchors exactly where round N did.
    expect(dirty.sha).toBe(branchPoint);
    expect(dirty.anchored).toBe(true);
    // ...but `ahead` now reports what the anchor is NOT showing the reviewer.
    expect(dirty.ahead).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("anchor: falls back to anchored:false when there is no origin to merge-base against", () => {
  const root = mkdtempSync(join(tmpdir(), "shep-anchor-solo-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main", root], { stdio: "pipe" });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: root, stdio: "pipe" });
    spawnSync("git", ["config", "user.name", "T"], { cwd: root, stdio: "pipe" });
    writeFileSync(join(root, "a.ts"), "1\n");
    spawnSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
    spawnSync("git", ["commit", "-qm", "only"], { cwd: root, stdio: "pipe" });

    const r = defaultPlanAnchorSha(root, "main", root);
    // No `origin/main` ⇒ no merge-base ⇒ the legacy chain runs and the prompt must degrade.
    expect(r.anchored).toBe(false);
    expect(r.ahead).toBe(0);
    // The local `main` rung still yields a real sha (rev-parse resolves the ref) — createDetached
    // needs a hex sha, so only this rung and `origin/<base>` can actually reach a spawned review.
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("anchor: never throws on a non-repo path", () => {
  const r = defaultPlanAnchorSha("/nonexistent-path-xyz", "main", "/nonexistent-path-xyz");
  expect(r).toEqual({ sha: "main", anchored: false, ahead: 0 });
});

test("staleness: counts commits + changed paths on the base branch since the anchor", () => {
  const { root, upstream, clone, git, branchPoint } = scaffold();
  try {
    // main moves on after the session branched
    writeFileSync(join(upstream, "existing.ts"), "export const a = 99;\n");
    writeFileSync(join(upstream, "brand-new.ts"), "export const n = 1;\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "main moves on");

    // nothing yet — the clone has not fetched, which is exactly the pre-fetch blind spot the
    // production ordering avoids by calling this AFTER createDetached's fetch.
    expect(defaultAnchorStaleness(clone, branchPoint, "main")).toEqual({
      behind: 0,
      changedSince: [],
    });

    git(clone, "fetch", "-q", "origin", "main");
    const after = defaultAnchorStaleness(clone, branchPoint, "main");
    expect(after.behind).toBe(1);
    expect(after.changedSince.sort()).toEqual(["brand-new.ts", "existing.ts"]);
    expect(after.more).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: caps the path list and reports the overflow count", () => {
  const { root, upstream, clone, git, branchPoint } = scaffold();
  try {
    for (let i = 0; i < 55; i++)
      writeFileSync(join(upstream, `f${i}.ts`), `export const x=${i};\n`);
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "many files");
    git(clone, "fetch", "-q", "origin", "main");

    const s = defaultAnchorStaleness(clone, branchPoint, "main");
    expect(s.behind).toBe(1);
    expect(s.changedSince.length).toBe(50); // CHANGED_SINCE_CAP
    expect(s.more).toBe(5); // 55 - 50, so the prompt can say "and 5 more" honestly
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness: zeroed (never throws) on a bad sha / non-repo", () => {
  expect(defaultAnchorStaleness("/nonexistent-path-xyz", "abc1234", "main")).toEqual({
    behind: 0,
    changedSince: [],
  });
  expect(defaultAnchorStaleness(process.cwd(), "not-a-sha; rm -rf /", "main")).toEqual({
    behind: 0,
    changedSince: [],
  });
});
