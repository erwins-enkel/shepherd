import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseIssues, githubSlug, listIssues } from "../src/github";

// ── fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_JSON = JSON.stringify([
  {
    number: 1,
    title: "Fix crash",
    body: "Crashes on startup",
    url: "https://github.com/o/r/issues/1",
    labels: [{ name: "bug" }, { name: "ui" }],
  },
  {
    number: 2,
    title: "Add feature",
    url: "https://github.com/o/r/issues/2",
    // no body, no labels
  },
]);

// ── parseIssues ───────────────────────────────────────────────────────────────

test("parseIssues: maps labels and defaults missing body/labels", () => {
  const issues = parseIssues(FIXTURE_JSON);
  expect(issues).toHaveLength(2);
  expect(issues[0]).toEqual({
    number: 1,
    title: "Fix crash",
    body: "Crashes on startup",
    url: "https://github.com/o/r/issues/1",
    labels: ["bug", "ui"],
  });
  expect(issues[1]).toEqual({
    number: 2,
    title: "Add feature",
    body: "",
    url: "https://github.com/o/r/issues/2",
    labels: [],
  });
});

// ── githubSlug ────────────────────────────────────────────────────────────────

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), "tank-github-test-"));
  execFileSync("git", ["init", "-q", tmpRepo]);
});

afterEach(() => rmSync(tmpRepo, { recursive: true, force: true }));

test("githubSlug: https github remote → slug", () => {
  execFileSync("git", ["-C", tmpRepo, "remote", "add", "origin", "https://github.com/o/r.git"]);
  expect(githubSlug(tmpRepo)).toBe("o/r");
});

test("githubSlug: ssh github remote → slug", () => {
  execFileSync("git", ["-C", tmpRepo, "remote", "add", "origin", "https://github.com/o/r.git"]);
  execFileSync("git", ["-C", tmpRepo, "remote", "set-url", "origin", "git@github.com:o2/r2.git"]);
  expect(githubSlug(tmpRepo)).toBe("o2/r2");
});

test("githubSlug: non-github remote → null", () => {
  execFileSync("git", ["-C", tmpRepo, "remote", "add", "origin", "https://gitea.local/x/y.git"]);
  expect(githubSlug(tmpRepo)).toBeNull();
});

test("githubSlug: no remote → null", () => {
  expect(githubSlug(tmpRepo)).toBeNull();
});

// ── listIssues ────────────────────────────────────────────────────────────────

test("listIssues: github origin + injected run → populated issues", () => {
  execFileSync("git", ["-C", tmpRepo, "remote", "add", "origin", "https://github.com/o/r.git"]);
  const result = listIssues(tmpRepo, () => FIXTURE_JSON);
  expect(result.slug).toBe("o/r");
  expect(result.issues).toHaveLength(2);
  expect(result.issues[0]!.labels).toEqual(["bug", "ui"]);
});

test("listIssues: no github origin → {slug:null, issues:[]}", () => {
  const result = listIssues(tmpRepo, () => FIXTURE_JSON);
  expect(result).toEqual({ slug: null, issues: [] });
});

test("listIssues: run throws → {slug, issues:[]}", () => {
  execFileSync("git", ["-C", tmpRepo, "remote", "add", "origin", "https://github.com/o/r.git"]);
  const result = listIssues(tmpRepo, () => {
    throw new Error("gh failed");
  });
  expect(result.slug).toBe("o/r");
  expect(result.issues).toEqual([]);
});
