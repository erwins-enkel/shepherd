import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasLocalWork } from "../src/schedule-noop";
import { g, makeFixture } from "./helpers/git-fixture";

function isolated() {
  const f = makeFixture();
  const wt = join(f.root, "wt");
  g(f.repo, "worktree", "add", "-q", "-b", "task", wt, "main");
  const s = {
    isolated: true,
    branch: "task",
    baseBranch: "main",
    repoPath: f.repo,
    worktreePath: wt,
  };
  return { s, wt };
}

test("clean worktree with no commits beyond base ⇒ no work", async () => {
  expect(await hasLocalWork(isolated().s)).toBe(false);
});

test("dirty worktree ⇒ work", async () => {
  const { s, wt } = isolated();
  writeFileSync(join(wt, "new.txt"), "x\n");
  expect(await hasLocalWork(s)).toBe(true);
});

test("a commit beyond base ⇒ work", async () => {
  const { s, wt } = isolated();
  writeFileSync(join(wt, "new.txt"), "x\n");
  g(wt, "add", "new.txt");
  g(wt, "commit", "-q", "-m", "change");
  expect(await hasLocalWork(s)).toBe(true);
});

test("git failure (unknown base) ⇒ work", async () => {
  const { s } = isolated();
  expect(await hasLocalWork({ ...s, baseBranch: "nope" })).toBe(true);
});

test("non-isolated session ⇒ no work to lose", async () => {
  const { s } = isolated();
  expect(await hasLocalWork({ ...s, isolated: false })).toBe(false);
});
