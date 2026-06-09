/**
 * Regression guard: no src/ file may import `execFileSync` from "node:child_process".
 * All blocking sync exec must route through ./instrument (or ../instrument) so it's
 * profiled under SHEPHERD_PROFILE_LOOP=1.
 *
 * The only allowlisted file is src/instrument.ts itself (the wrapper definition).
 */
import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "src");

/** Walk a directory tree and return all .ts file paths. */
function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Matches any import statement that pulls `execFileSync` from "node:child_process".
 * Handles single-line and multi-line named imports, e.g.
 *   import { execFileSync } from "node:child_process"
 *   import { execFile, execFileSync, spawn } from "node:child_process"
 *   import {
 *     execFileSync,
 *   } from "node:child_process"
 */
const PATTERN = /import\s*\{[\s\S]*?\bexecFileSync\b[\s\S]*?\}\s*from\s*["']node:child_process["']/;

/** Allowlist: files permitted to import execFileSync from node:child_process. */
const ALLOWLIST = new Set(["src/instrument.ts"]);

test("PATTERN matches a multi-line execFileSync import (self-check)", () => {
  const multiLine = `import {\n  execFileSync,\n} from "node:child_process"`;
  expect(PATTERN.test(multiLine)).toBe(true);
});

test("PATTERN does not match an async execFile import (no false positive)", () => {
  const asyncOnly = `import { execFile, spawn } from "node:child_process"`;
  expect(PATTERN.test(asyncOnly)).toBe(false);
});

test("no src file imports execFileSync from node:child_process (use ./instrument instead)", () => {
  const violations: string[] = [];

  for (const file of collectTs(SRC_ROOT)) {
    const rel = relative(join(SRC_ROOT, ".."), file); // relative to repo root
    if (ALLOWLIST.has(rel)) continue;

    const src = readFileSync(file, "utf8");
    if (PATTERN.test(src)) {
      violations.push(rel);
    }
  }

  expect(
    violations,
    [
      "These files import execFileSync from node:child_process directly.",
      "Import it from ./instrument (or ../instrument) instead, so it's profiled.",
      "Violations:",
      ...violations,
    ].join("\n"),
  ).toEqual([]);
});
