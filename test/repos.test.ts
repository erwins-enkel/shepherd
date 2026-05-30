import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRepos, readTodo, writeTodo } from "../src/repos";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-repos-test-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  writeFileSync(join(root, "README"), "not a dir");
  mkdirSync(join(root, ".hidden"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── listRepos ─────────────────────────────────────────────────────────────────

test("listRepos returns sorted dirs, excludes file and dotdir", () => {
  const repos = listRepos(root);
  expect(repos.map((r) => r.name)).toEqual(["alpha", "beta"]);
  expect(repos[0]!.path).toBe(join(root, "alpha"));
  expect(repos[1]!.path).toBe(join(root, "beta"));
});

test("listRepos returns [] for nonexistent root", () => {
  expect(listRepos(join(root, "nonexistent"))).toEqual([]);
});

// ── readTodo ──────────────────────────────────────────────────────────────────

test("readTodo: no TODO.md → ok:true exists:false content:''", () => {
  const r = readTodo(join(root, "alpha"), root);
  expect(r).toEqual({ ok: true, exists: false, content: "" });
});

test("readTodo: outside repoRoot → ok:false", () => {
  const r = readTodo("/etc", root);
  expect(r.ok).toBe(false);
});

// ── writeTodo + round-trip ────────────────────────────────────────────────────

test("writeTodo writes and readTodo reads back (round-trip)", () => {
  const repoPath = join(root, "alpha");
  const wrote = writeTodo(repoPath, root, "- [ ] x");
  expect(wrote).toBe(true);
  const r = readTodo(repoPath, root);
  expect(r).toEqual({ ok: true, exists: true, content: "- [ ] x" });
});

test("writeTodo: outside repoRoot → false", () => {
  expect(writeTodo("/etc", root, "x")).toBe(false);
});

test("writeTodo: content > 100_000 chars → false", () => {
  expect(writeTodo(join(root, "alpha"), root, "x".repeat(100_001))).toBe(false);
});

test("writeTodo: content exactly 100_000 chars → true", () => {
  expect(writeTodo(join(root, "alpha"), root, "x".repeat(100_000))).toBe(true);
});
