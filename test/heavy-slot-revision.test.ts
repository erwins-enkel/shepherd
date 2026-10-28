import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRevision, isStale } from "../src/heavy-slot-revision";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slot-rev-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("captureRevision / isStale", () => {
  test("an untouched worktree is not stale", async () => {
    const a = await captureRevision(dir, dir);
    expect(a.head).toMatch(/^[0-9a-f]{40}$/);
    expect(isStale(a, await captureRevision(dir, dir))).toBe(false);
  });

  test("a tracked edit makes it stale, reverting it makes it current again", async () => {
    const a = await captureRevision(dir, dir);
    writeFileSync(join(dir, "a.txt"), "b\n");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(true);
    writeFileSync(join(dir, "a.txt"), "a\n");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(false);
  });

  test("a new untracked file makes it stale", async () => {
    const a = await captureRevision(dir, dir);
    writeFileSync(join(dir, "new.txt"), "x");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(true);
  });

  test("a new commit makes it stale", async () => {
    const a = await captureRevision(dir, dir);
    writeFileSync(join(dir, "a.txt"), "c\n");
    git("commit", "-qam", "next");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(true);
  });

  test("a non-repository has no head and is always stale", async () => {
    const plain = mkdtempSync(join(tmpdir(), "slot-rev-plain-"));
    try {
      const r = await captureRevision(plain, plain);
      expect(r.head).toBeNull();
      expect(isStale(r, r)).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
