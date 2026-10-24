import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  execGit,
  resolveWorktreePin,
  resolveWorktreePinSync,
  safeGitArgs,
  SAFE_GIT_CONFIG,
  trustedUnionDriverConfig,
  UntrustedGitDirError,
} from "../src/safe-git";
import { g, makeFixture, markerLines, plantScript, type Fixture } from "./helpers/git-fixture";

const PREFIX = SAFE_GIT_CONFIG.flatMap(([k, v]) => ["-c", `${k}=${v}`]);

let f: Fixture | null = null;
afterEach(() => {
  if (f) rmSync(f.root, { recursive: true, force: true });
  f = null;
});

test("safeGitArgs prepends the hardening config", () => {
  expect(safeGitArgs(["status", "--porcelain"])).toEqual([...PREFIX, "status", "--porcelain"]);
  expect(PREFIX).toContain("core.hooksPath=/dev/null");
  expect(PREFIX).toContain("core.fsmonitor=false");
  expect(PREFIX).toContain("protocol.ext.allow=never");
});

test("safeGitArgs disables ext-diff/textconv after diff/log/show, skipping global options", () => {
  expect(safeGitArgs(["diff", "a...b"])).toEqual([
    ...PREFIX,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "a...b",
  ]);
  expect(safeGitArgs(["-C", "/r", "-c", "x=y", "log", "--oneline"])).toEqual([
    ...PREFIX,
    "-C",
    "/r",
    "-c",
    "x=y",
    "log",
    "--no-ext-diff",
    "--no-textconv",
    "--oneline",
  ]);
  expect(safeGitArgs(["-C", "/r", "fetch", "origin"])).toEqual([
    ...PREFIX,
    "-C",
    "/r",
    "fetch",
    "origin",
  ]);
});

test("safeGitArgs applies extra config after the hardening set", () => {
  const [k, v] = trustedUnionDriverConfig();
  expect(safeGitArgs(["rebase"], [[k, v]])).toEqual([...PREFIX, "-c", `${k}=${v}`, "rebase"]);
  expect(v).toMatch(/^node '.+\/scripts\/json-union-merge\.mjs' %O %A %B %P$/);
});

test("execGit ignores repo hooks and fsmonitor", async () => {
  f = makeFixture();
  plantScript(join(f.repo, ".git", "fsmon.sh"), f.marker, "FSMON");
  g(f.repo, "config", "core.fsmonitor", join(f.repo, ".git", "fsmon.sh"));
  writeFileSync(join(f.repo, "README.md"), "changed\n");
  await execGit(["status", "--porcelain"], { cwd: f.repo });
  expect(markerLines(f.marker)).toEqual([]);
});

test("resolveWorktreePin finds the admin dir from the trusted repo path", async () => {
  f = makeFixture();
  const wt = join(f.root, "wt");
  g(f.repo, "worktree", "add", "-q", "-b", "task", wt, "main");
  const pin = await resolveWorktreePin(f.repo, wt);
  expect(pin).not.toBeNull();
  expect(pin!.gitDir).toContain(join(".git", "worktrees"));
  expect(resolveWorktreePinSync(f.repo, wt)).toEqual(pin);
  const { stdout } = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt, pin });
  expect(stdout.trim()).toBe("task");
});

test("resolveWorktreePin matches a worktree added through a symlinked path", async () => {
  f = makeFixture();
  const link = join(f.root, "link");
  symlinkSync(f.root, link);
  const viaLink = join(link, "wt");
  g(f.repo, "worktree", "add", "-q", "-b", "task", viaLink, "main");
  const pin = await resolveWorktreePin(f.repo, viaLink);
  expect(pin?.workTree).toBe(realpathSync(viaLink));
  expect(await resolveWorktreePin(f.repo, join(f.root, "wt"))).toEqual(pin);
});

test("resolveWorktreePin is null for a non-isolated session (worktree IS the repo)", async () => {
  f = makeFixture();
  expect(await resolveWorktreePin(f.repo, f.repo)).toBeNull();
  expect(resolveWorktreePinSync(f.repo, f.repo)).toBeNull();
});

test("a repointed worktree gitfile does not redirect the pin", async () => {
  f = makeFixture();
  const wt = join(f.root, "wt");
  g(f.repo, "worktree", "add", "-q", "-b", "task", wt, "main");
  const evil = join(f.root, "evil");
  g(f.root, "clone", "-q", f.origin, evil);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, ".git")}\n`);
  const pin = await resolveWorktreePin(f.repo, wt);
  expect(pin!.gitDir.startsWith(join(f.repo, ".git", "worktrees"))).toBe(true);
});

test("an unregistered worktree fails closed", async () => {
  f = makeFixture();
  const stray = join(f.root, "stray");
  mkdirSync(stray);
  writeFileSync(join(stray, ".git"), `gitdir: ${join(f.root, "elsewhere")}\n`);
  await expect(resolveWorktreePin(f.repo, stray)).rejects.toBeInstanceOf(UntrustedGitDirError);
  expect(() => resolveWorktreePinSync(f!.repo, stray)).toThrow(UntrustedGitDirError);
});

test("a planted admin dir whose commondir points elsewhere is rejected", async () => {
  f = makeFixture();
  const stray = join(f.root, "stray");
  mkdirSync(stray);
  const fake = join(f.repo, ".git", "worktrees", "fake");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "gitdir"), `${join(stray, ".git")}\n`);
  writeFileSync(join(fake, "commondir"), `${join(f.root, "evil", ".git")}\n`);
  await expect(resolveWorktreePin(f.repo, stray)).rejects.toBeInstanceOf(UntrustedGitDirError);
});
