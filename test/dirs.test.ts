import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirs, validateRoot, collapseHome } from "../src/dirs";

// `ceiling` is the immutable repo-root ceiling for these tests; the dir browser
// and validateRoot must never resolve outside it.
let ceiling: string;

beforeEach(() => {
  // realpath so comparisons hold on platforms where tmpdir() is a symlink (macOS)
  ceiling = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-dirs-test-")));
  mkdirSync(join(ceiling, "alpha"));
  mkdirSync(join(ceiling, "beta"));
  mkdirSync(join(ceiling, ".hidden"));
  mkdirSync(join(ceiling, "alpha", "nested"));
  writeFileSync(join(ceiling, "file.txt"), "not a dir");
});

afterEach(() => rmSync(ceiling, { recursive: true, force: true }));

// ── listDirs ──────────────────────────────────────────────────────────────────

test("listDirs lists real sub-dirs within the ceiling (excludes files/dotdirs)", () => {
  const l = listDirs(ceiling, ceiling);
  expect(l.path).toBe(ceiling);
  expect(l.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  expect(l.entries[0]!.path).toBe(join(ceiling, "alpha"));
});

test("listDirs at the ceiling returns parent === null (never exposes the ceiling's parent)", () => {
  const l = listDirs(ceiling, ceiling);
  expect(l.parent).toBeNull();
});

test("listDirs lists a nested subdir within the ceiling and exposes its parent up to the ceiling", () => {
  const l = listDirs(join(ceiling, "alpha"), ceiling);
  expect(l.path).toBe(join(ceiling, "alpha"));
  expect(l.entries.map((e) => e.name)).toEqual(["nested"]);
  expect(l.parent).toBe(ceiling);
});

test("listDirs clamps a path OUTSIDE the ceiling back to the ceiling", () => {
  for (const outside of ["/etc", "/", "/tmp", "/usr/bin"]) {
    const l = listDirs(outside, ceiling);
    expect(l.path).toBe(ceiling);
    expect(l.parent).toBeNull();
    expect(l.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  }
});

test("listDirs clamps empty input to the ceiling (not $HOME)", () => {
  const l = listDirs("", ceiling);
  expect(l.path).toBe(ceiling);
  expect(l.parent).toBeNull();
});

test("listDirs climbs to the parent when the path is a file (staying within the ceiling)", () => {
  const l = listDirs(join(ceiling, "file.txt"), ceiling);
  expect(l.path).toBe(ceiling);
});

// ── validateRoot ────────────────────────────────────────────────────────────────

test("validateRoot ACCEPTS a dir inside the ceiling (and the ceiling itself)", () => {
  expect(validateRoot(join(ceiling, "alpha"), ceiling)).toBe(join(ceiling, "alpha"));
  expect(validateRoot(join(ceiling, "alpha", "nested"), ceiling)).toBe(
    join(ceiling, "alpha", "nested"),
  );
  expect(validateRoot(ceiling, ceiling)).toBe(ceiling);
});

test("validateRoot REJECTS a dir outside the ceiling", () => {
  expect(validateRoot("/tmp", ceiling)).toBeNull();
  expect(validateRoot("/etc", ceiling)).toBeNull();
  expect(validateRoot("/", ceiling)).toBeNull();
});

test("validateRoot rejects a file, a non-existent path, and non-strings", () => {
  expect(validateRoot(join(ceiling, "file.txt"), ceiling)).toBeNull();
  expect(validateRoot(join(ceiling, "nope"), ceiling)).toBeNull();
  expect(validateRoot("", ceiling)).toBeNull();
  expect(validateRoot(null, ceiling)).toBeNull();
  expect(validateRoot(42, ceiling)).toBeNull();
});

// ── collapseHome ────────────────────────────────────────────────────────────────

test("collapseHome collapses the home prefix to ~", () => {
  const home = process.env.HOME ?? "";
  expect(collapseHome(join(home, "Work"))).toBe("~/Work");
  expect(collapseHome("/opt/elsewhere")).toBe("/opt/elsewhere");
});
