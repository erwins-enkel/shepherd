/**
 * Guard for audit F01/F02/F05/F07: every server-side git invocation goes through src/safe-git.ts.
 * Fails on a raw `execFile*("git", …)` / `spawn*("git", …)` anywhere else in src/, unless the
 * file is allowlisted below with the reason its git never touches agent- or PR-provided content.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** file → how many raw git launches it may hold, and why they never touch agent content. */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "safe-git.ts": { count: 4, reason: "the helper itself" },
  "forge/local.ts": { count: 1, reason: "`git --version` probe only" },
  "github-access.ts": { count: 1, reason: "cwd `/`: reads only global credential config" },
  "plugins/manage.ts": { count: 1, reason: "clones a plugin into a fresh dir" },
  "plugin-update.ts": { count: 1, reason: "plugin checkouts, not agent worktrees" },
};

/** Raw git launches; `\s*` spans newlines so multi-line calls are caught. */
const RAW_GIT = /\b(?:execFile\w*|spawn\w*|execFileP)\(\s*["'`]git["'`]/g;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

test("no raw git exec outside safe-git and the allowlist", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    const text = readFileSync(file, "utf8");
    const hits = [...text.matchAll(RAW_GIT)].map((m) => `src/${rel}:${lineOf(text, m.index)}`);
    if (hits.length > (ALLOWLIST[rel]?.count ?? 0)) offenders.push(...hits);
  }
  expect(offenders).toEqual([]);
});

test("every allowlisted file still holds exactly its allowed raw git launches", () => {
  for (const [rel, { count }] of Object.entries(ALLOWLIST)) {
    const text = readFileSync(join(SRC, rel), "utf8");
    expect({ rel, count: [...text.matchAll(RAW_GIT)].length }).toEqual({ rel, count });
  }
});
