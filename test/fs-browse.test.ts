import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInRoot, listDir } from "../src/fs-browse";

// The scratchpad test suite (test/scratchpad.test.ts) already exercises the shared
// resolveInRoot/listDir paths end-to-end (containment, drop-on-escape, sort). These tests cover
// only the two NEW behaviors not reachable through scratchpad: hideSegment and onEscape:"mark".

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-fsbrowse-test-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-fsbrowse-out-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const hideGit = (seg: string) => seg === ".git";

test("resolveInRoot: hideSegment rejects a path with a matching segment, even though realpath is in-root", async () => {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "x");
  const r = await resolveInRoot(root, ".git/config", { hideSegment: hideGit });
  expect(r).toBeNull();
});

test("resolveInRoot: hideSegment does not affect unrelated paths", async () => {
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "x");
  const r = await resolveInRoot(root, "src/index.ts", { hideSegment: hideGit });
  expect(r).not.toBeNull();
});

test("listDir: hideSegment skips a matching child (e.g. .git) entirely", async () => {
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "readme.md"), "x");
  const l = await listDir(root, "", { hideSegment: hideGit });
  expect(l).not.toBeNull();
  expect(l!.entries.map((e) => e.name)).toEqual(["readme.md"]);
});

test('listDir: onEscape "drop" (default) omits a symlink resolving outside the root', async () => {
  writeFileSync(join(outside, "secret.txt"), "leak");
  symlinkSync(join(outside, "secret.txt"), join(root, "escapee"));
  const l = await listDir(root, "");
  expect(l).not.toBeNull();
  expect(l!.entries.map((e) => e.name)).toEqual([]);
});

test('listDir: onEscape "mark" surfaces an out-pointing symlink as non-navigable with linkOutside: true', async () => {
  writeFileSync(join(outside, "secret.txt"), "leak");
  symlinkSync(join(outside, "secret.txt"), join(root, "escapee"));
  const l = await listDir(root, "", { onEscape: "mark" });
  expect(l).not.toBeNull();
  expect(l!.entries).toEqual([
    { name: "escapee", type: "file", path: "escapee", linkOutside: true },
  ]);
});

test('listDir: onEscape "mark" also marks an out-pointing symlink to a directory', async () => {
  mkdirSync(join(outside, "otherdir"));
  symlinkSync(join(outside, "otherdir"), join(root, "escapee-dir"));
  const l = await listDir(root, "", { onEscape: "mark" });
  expect(l).not.toBeNull();
  expect(l!.entries).toEqual([
    { name: "escapee-dir", type: "dir", path: "escapee-dir", linkOutside: true },
  ]);
});
