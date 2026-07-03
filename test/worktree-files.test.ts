import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorktree, resolveWorktreeFile } from "../src/worktree-files";

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-worktree-test-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-worktree-out-")));

  // Regular file + subdir.
  writeFileSync(join(root, "README.md"), "# hi\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");

  // Dotfile (not hidden — only `.git` is hidden).
  writeFileSync(join(root, ".env"), "X=1\n");

  // `.git` FILE (as created by `git worktree add`) — a realistic gitdir pointer.
  writeFileSync(join(root, ".git"), "gitdir: /some/path/.git/worktrees/x\n");

  // Nested submodule dir with its own `.git` DIRECTORY.
  mkdirSync(join(root, "vendor", "lib"), { recursive: true });
  mkdirSync(join(root, "vendor", "lib", ".git"));
  writeFileSync(join(root, "vendor", "lib", ".git", "config"), "[core]\n");
  writeFileSync(join(root, "vendor", "lib", "package.json"), "{}\n");

  // Out-of-root symlink.
  writeFileSync(join(outside, "secret.txt"), "leak");
  symlinkSync(join(outside, "secret.txt"), join(root, "escapee"));

  // Broken symlink.
  symlinkSync(join(root, "does-not-exist"), join(root, "broken-link"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("listWorktree(root, ''): hides .git, shows others, marks out-of-root symlink, drops broken symlink, dirs before files", async () => {
  const listing = await listWorktree(root, "");
  expect(listing).not.toBeNull();
  const names = listing!.entries.map((e) => e.name);

  expect(names).not.toContain(".git");
  expect(names).not.toContain("broken-link");
  expect(names).toContain("README.md");
  expect(names).toContain("src");
  expect(names).toContain(".env");
  expect(names).toContain("vendor");
  expect(names).toContain("escapee");

  const escapee = listing!.entries.find((e) => e.name === "escapee");
  expect(escapee?.linkOutside).toBe(true);

  // dirs sort before files
  const dirIdx = listing!.entries.findIndex((e) => e.type === "dir");
  const fileIdx = listing!.entries.findIndex((e) => e.type === "file");
  expect(dirIdx).toBeLessThan(fileIdx);
});

test("listWorktree(root, 'vendor/lib'): nested .git directory is absent", async () => {
  const listing = await listWorktree(root, "vendor/lib");
  expect(listing).not.toBeNull();
  const names = listing!.entries.map((e) => e.name);
  expect(names).not.toContain(".git");
  expect(names).toContain("package.json");
});

test("resolveWorktreeFile(root, '.git') -> null (hidden segment rejected even inside root)", async () => {
  const r = await resolveWorktreeFile(root, ".git");
  expect(r).toBeNull();
});

test("resolveWorktreeFile(root, 'vendor/lib/.git/config') -> null (mid-path hideSegment match)", async () => {
  const r = await resolveWorktreeFile(root, "vendor/lib/.git/config");
  expect(r).toBeNull();
});

test("escape via '..' is rejected for both list and resolve", async () => {
  const rel = await resolveWorktreeFile(root, join("..", "secret.txt"));
  expect(rel).toBeNull();
  const listing = await listWorktree(root, "..");
  expect(listing).toBeNull();
});

test("resolveWorktreeFile rejects the out-of-root symlink", async () => {
  const r = await resolveWorktreeFile(root, "escapee");
  expect(r).toBeNull();
});

test("resolveWorktreeFile(root, 'README.md') -> canonical absolute path (happy path)", async () => {
  const r = await resolveWorktreeFile(root, "README.md");
  expect(r).toBe(join(root, "README.md"));
});

test("blank worktreePath guard: listWorktree('', '') -> null (never falls back to cwd)", async () => {
  expect(await listWorktree("", "")).toBeNull();
});

test("blank worktreePath guard: resolveWorktreeFile('', 'README.md') -> null", async () => {
  expect(await resolveWorktreeFile("", "README.md")).toBeNull();
});
