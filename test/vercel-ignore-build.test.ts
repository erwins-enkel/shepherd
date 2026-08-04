/**
 * Exit-code contract for scripts/vercel-ignore-build.sh — the Vercel "Ignored
 * Build Step" gate that stops all four Vercel projects rebuilding on every
 * commit (issue #2027).
 *
 * The polarity is INVERTED relative to every other script in this repo:
 *   exit 0 => CANCEL the build,  exit 1 => RUN the build.
 * Get it backwards and every deploy silently stops, with no failing build to
 * notice. So the contract is pinned here rather than trusted.
 *
 * The other half of the contract is that the gate FAILS OPEN: anything it
 * cannot prove — no previous SHA, a previous SHA missing from Vercel's
 * `--depth=10` shallow clone, no path arguments — must resolve to "build".
 *
 * Each test builds a throwaway git repo laid out like the real one (a project
 * subdirectory plus sibling inputs it reads and inputs it does not) and runs
 * the gate from the project directory, exactly as Vercel runs it from a
 * project's Root Directory. Same shape as test/check-generated-docs.test.ts.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "scripts", "vercel-ignore-build.sh");

/** Vercel's contract, named so the assertions read as intent, not as numbers. */
const CANCEL = 0;
const BUILD = 1;

/** Stands in for `docs-site` (the project root) and the inputs around it. */
const PROJECT = "proj";
/** Gated paths, as passed from the project's Root Directory. */
const GATED = ["./", "../src", "../CLAUDE.md"];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;
/** SHA of the seed commit — what Vercel would report as the last deploy. */
let previous: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" });
}

function writeRepoFile(rel: string, contents: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function commit(subject: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", subject);
  return git("rev-parse", "HEAD").trim();
}

/** Run the gate from the project directory. `prev` unset ⇒ variable absent. */
function runGate(prev: string | undefined, paths: string[] = GATED): { code: number; out: string } {
  const env: Record<string, string> = { ...GIT_ENV };
  if (prev === undefined) delete env.VERCEL_GIT_PREVIOUS_SHA;
  else env.VERCEL_GIT_PREVIOUS_SHA = prev;
  const r = spawnSync("bash", [SCRIPT, ...paths], {
    cwd: join(repo, PROJECT),
    env,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shepherd-vercel-ignore-"));
  git("init", "-q", "-b", "main");
  writeRepoFile(`${PROJECT}/astro.config.mjs`, "// v1\n");
  writeRepoFile("src/server.ts", "// v1\n");
  writeRepoFile("CLAUDE.md", "# v1\n");
  // Not gated: stands in for the rest of the repo (test/, other packages, …).
  writeRepoFile("unrelated/thing.ts", "// v1\n");
  previous = commit("chore: seed");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("no gated path changed → cancels the build", () => {
  writeRepoFile("unrelated/thing.ts", "// v2\n");
  commit("chore: touch something this project never reads");
  const { code, out } = runGate(previous);
  expect(code).toBe(CANCEL);
  expect(out).toMatch(/skip|cancel/i);
});

test("a file inside the project root changed → builds", () => {
  writeRepoFile(`${PROJECT}/astro.config.mjs`, "// v2\n");
  commit("feat: change the project itself");
  expect(runGate(previous).code).toBe(BUILD);
});

test("a sibling input outside the project root changed → builds", () => {
  writeRepoFile("src/server.ts", "// v2\n");
  commit("feat: change ../src, which this project documents");
  expect(runGate(previous).code).toBe(BUILD);
});

test("a gated single file outside the project root changed → builds", () => {
  writeRepoFile("CLAUDE.md", "# v2\n");
  commit("docs: change ../CLAUDE.md, which this project imports");
  expect(runGate(previous).code).toBe(BUILD);
});

test("several commits since the previous deploy, only one relevant → builds", () => {
  writeRepoFile("unrelated/thing.ts", "// v2\n");
  commit("chore: irrelevant");
  writeRepoFile("src/server.ts", "// v2\n");
  commit("feat: relevant");
  writeRepoFile("unrelated/thing.ts", "// v3\n");
  commit("chore: irrelevant again");
  // HEAD^ would compare against the wrong commit and wrongly cancel here.
  expect(runGate(previous).code).toBe(BUILD);
});

test("VERCEL_GIT_PREVIOUS_SHA unset → fails open and builds", () => {
  writeRepoFile("unrelated/thing.ts", "// v2\n");
  commit("chore: irrelevant");
  const { code, out } = runGate(undefined);
  expect(code).toBe(BUILD);
  expect(out).toMatch(/previous/i);
});

test("VERCEL_GIT_PREVIOUS_SHA empty → fails open and builds", () => {
  writeRepoFile("unrelated/thing.ts", "// v2\n");
  commit("chore: irrelevant");
  expect(runGate("").code).toBe(BUILD);
});

test("previous SHA absent from the clone (shallow-clone truncation) → fails open and builds", () => {
  writeRepoFile("unrelated/thing.ts", "// v2\n");
  commit("chore: irrelevant");
  // A well-formed SHA that is simply not in this repository — what Vercel's
  // `git clone --depth=10` leaves behind once a project has skipped >10 commits.
  const { code, out } = runGate("0123456789abcdef0123456789abcdef01234567");
  expect(code).toBe(BUILD);
  expect(out).toMatch(/not in|unreachable|missing/i);
});

test("no path arguments → fails open and builds", () => {
  const { code, out } = runGate(previous, []);
  expect(code).toBe(BUILD);
  expect(out).toMatch(/path/i);
});

test("run outside a git repository → fails open and builds", () => {
  const outside = mkdtempSync(join(tmpdir(), "shepherd-vercel-ignore-nogit-"));
  try {
    const r = spawnSync("bash", [SCRIPT, "./"], {
      cwd: outside,
      env: { ...GIT_ENV, VERCEL_GIT_PREVIOUS_SHA: previous },
      encoding: "utf8",
    });
    expect(r.status).toBe(BUILD);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
