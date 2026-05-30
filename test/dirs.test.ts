import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { listDirs, validateRoot, collapseHome } from "../src/dirs";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shepherd-dirs-test-"));
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "file.txt"), "not a dir");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── listDirs ──────────────────────────────────────────────────────────────────

test("listDirs returns sorted sub-dirs, excludes files and dotdirs", () => {
  const l = listDirs(root);
  expect(l.path).toBe(root);
  expect(l.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  expect(l.entries[0]!.path).toBe(join(root, "alpha"));
  expect(l.parent).toBe(dirname(root));
});

test("listDirs climbs to parent when the path is a file", () => {
  const l = listDirs(join(root, "file.txt"));
  expect(l.path).toBe(root);
  expect(l.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
});

test("listDirs on a leaf dir returns empty entries but a valid parent", () => {
  const l = listDirs(join(root, "alpha"));
  expect(l.entries).toEqual([]);
  expect(l.parent).toBe(root);
});

test("listDirs falls back to $HOME for empty input", () => {
  const l = listDirs("");
  expect(l.path).toBe(process.env.HOME ?? "/");
});

// ── validateRoot ────────────────────────────────────────────────────────────────

test("validateRoot accepts an existing directory and returns the resolved path", () => {
  expect(validateRoot(join(root, "alpha"))).toBe(join(root, "alpha"));
});

test("validateRoot rejects a file, a non-existent path, and non-strings", () => {
  expect(validateRoot(join(root, "file.txt"))).toBeNull();
  expect(validateRoot(join(root, "nope"))).toBeNull();
  expect(validateRoot("")).toBeNull();
  expect(validateRoot(null)).toBeNull();
  expect(validateRoot(42)).toBeNull();
});

// ── collapseHome ────────────────────────────────────────────────────────────────

test("collapseHome collapses the home prefix to ~", () => {
  const home = process.env.HOME ?? "";
  expect(collapseHome(join(home, "Work"))).toBe("~/Work");
  expect(collapseHome("/opt/elsewhere")).toBe("/opt/elsewhere");
});
