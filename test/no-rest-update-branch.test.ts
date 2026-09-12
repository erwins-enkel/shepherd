/**
 * Regression guard (#1551): no src/ file may update a PR branch through GitHub's REST
 * `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch`.
 *
 * That endpoint updates a PR by MERGING the base branch into it, which violates Shepherd's
 * linear-history policy (rebase-only; "never git merge main into your branch"). The allowed
 * automatic paths are the existing agent rebase steers — AutopilotService.reEngageRebase, the
 * merge train's rebase recovery, and the epic landing rebase — or, should one ever be added,
 * GraphQL `updatePullRequestBranch(updateMethod: REBASE)`. This guard deliberately does NOT
 * forbid that GraphQL mutation; it forbids only the merge-flavoured REST route.
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
    if (entry.isDirectory()) results.push(...collectTs(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) results.push(full);
  }
  return results;
}

/** Matches the REST path segment, however the owner/repo/number parts are interpolated:
 *    `repos/${slug}/pulls/${n}/update-branch`
 *    "/repos/acme/app/pulls/12/update-branch"
 *  Anchored on `pulls/…/update-branch` so an unrelated string containing "update-branch"
 *  (a branch name, a log line) does not trip it. */
const PATTERN = /pulls\/[^"'`\s]*\/update-branch/;

test("PATTERN matches an interpolated REST update-branch path (self-check)", () => {
  expect(PATTERN.test("`repos/${slug}/pulls/${n}/update-branch`")).toBe(true);
  expect(PATTERN.test('"/repos/acme/app/pulls/12/update-branch"')).toBe(true);
});

test("PATTERN does not match the GraphQL mutation or unrelated text (no false positive)", () => {
  expect(PATTERN.test("updatePullRequestBranch(input: $input)")).toBe(false);
  expect(PATTERN.test("shepherd/update-branch-name")).toBe(false);
});

test("no src file updates a PR branch via REST update-branch (it merges base in)", () => {
  const violations: string[] = [];

  for (const file of collectTs(SRC_ROOT)) {
    if (PATTERN.test(readFileSync(file, "utf8"))) {
      violations.push(relative(join(SRC_ROOT, ".."), file));
    }
  }

  expect(violations).toEqual([]);
});
