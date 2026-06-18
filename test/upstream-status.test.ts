import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { upstreamStatus } from "../src/upstream-status";

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

test("upstreamStatus: up to date — fresh clone, no divergence", async () => {
  const status = await upstreamStatus(repo, "main");
  expect(status.hasUpstream).toBe(true);
  expect(status.localExists).toBe(true);
  expect(status.behind).toBe(0);
  expect(status.ahead).toBe(0);
  expect(status.diverged).toBe(false);
  expect(status.upstreamSha).not.toBeNull();
  expect(status.localSha).not.toBeNull();
  expect(status.upstreamSha).toBe(status.localSha);
});

test("upstreamStatus: origin ahead (clean ff) — behind>0, ahead===0, diverged===false", async () => {
  // Advance origin/main from a second clone+push
  const other = mkdtempSync(join(tmpdir(), "shepherd-other-"));
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
  commit(other, "z.txt", "new", "advance main");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  rmSync(other, { recursive: true, force: true });

  const localSha = revParse(repo, "main");
  const status = await upstreamStatus(repo, "main");

  expect(status.hasUpstream).toBe(true);
  expect(status.localExists).toBe(true);
  expect(status.behind).toBeGreaterThan(0);
  expect(status.ahead).toBe(0);
  expect(status.diverged).toBe(false);
  expect(status.upstreamSha).not.toBeNull();
  expect(status.localSha).toBe(localSha);
  expect(status.upstreamSha).not.toBe(status.localSha);
});

test("upstreamStatus: diverged — behind>0, ahead>0, diverged===true", async () => {
  // Commit locally on main (don't push)
  commit(repo, "local.txt", "local change", "local commit");
  const localSha = revParse(repo, "main");

  // Advance origin/main separately from a second clone
  const other = mkdtempSync(join(tmpdir(), "shepherd-other-"));
  execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
  commit(other, "remote.txt", "remote change", "remote commit");
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  rmSync(other, { recursive: true, force: true });

  const status = await upstreamStatus(repo, "main");

  expect(status.hasUpstream).toBe(true);
  expect(status.localExists).toBe(true);
  expect(status.behind).toBeGreaterThan(0);
  expect(status.ahead).toBeGreaterThan(0);
  expect(status.diverged).toBe(true);
  expect(status.localSha).toBe(localSha);
  expect(status.upstreamSha).not.toBe(status.localSha);
});

test("upstreamStatus: origin-only branch (epic/9-x) — hasUpstream, !localExists, counts 0", async () => {
  // epic/9-x exists on origin but NOT locally (single-branch clone of main)
  const status = await upstreamStatus(repo, "epic/9-x");

  expect(status.hasUpstream).toBe(true);
  expect(status.localExists).toBe(false);
  expect(status.behind).toBe(0);
  expect(status.ahead).toBe(0);
  expect(status.diverged).toBe(false);
  expect(status.upstreamSha).not.toBeNull();
  expect(status.localSha).toBeNull();
});

test("upstreamStatus: stale tracking ref / origin unreachable — no throw, hasUpstream still true", async () => {
  // First call to populate refs/remotes/origin/main
  const first = await upstreamStatus(repo, "main");
  expect(first.hasUpstream).toBe(true);

  // Point origin at a non-existent path so the fetch will fail
  execFileSync("git", ["remote", "set-url", "origin", "/no/such/repo"], {
    cwd: repo,
    stdio: "pipe",
  });

  // Should not throw; stale tracking ref still resolves
  const status = await upstreamStatus(repo, "main");
  expect(status.hasUpstream).toBe(true); // stale tracking ref still resolves
});

test("upstreamStatus: no upstream at all — hasUpstream===false, no throw", async () => {
  // A repo with no origin remote (or unreachable + no pre-existing tracking ref)
  const bare = mkdtempSync(join(tmpdir(), "shepherd-noremote-"));
  execFileSync("git", ["init", "-q", "-b", "main", bare], { stdio: "pipe" });
  commit(bare, "x.txt", "1", "init");

  const status = await upstreamStatus(bare, "main");

  expect(status.hasUpstream).toBe(false);
  expect(status.localExists).toBe(true); // local main exists
  expect(status.behind).toBe(0);
  expect(status.ahead).toBe(0);
  expect(status.diverged).toBe(false);
  expect(status.upstreamSha).toBeNull();

  rmSync(bare, { recursive: true, force: true });
});

test("upstreamStatus: invalid base name ('--evil') — fail-closed result, no throw", async () => {
  const status = await upstreamStatus(repo, "--evil");

  expect(status.hasUpstream).toBe(false);
  expect(status.localExists).toBe(false);
  expect(status.upstreamSha).toBeNull();
  expect(status.localSha).toBeNull();
  expect(status.behind).toBe(0);
  expect(status.ahead).toBe(0);
  expect(status.diverged).toBe(false);
});
