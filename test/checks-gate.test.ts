import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoHasNoCi, checksCleared, repoHasNoCiCached } from "../src/checks-gate";

test("repoHasNoCi: github + zero workflows → true", () => {
  expect(repoHasNoCi("github", 0)).toBe(true);
});

test("repoHasNoCi: github + ≥1 workflow → false", () => {
  expect(repoHasNoCi("github", 1)).toBe(false);
});

test("repoHasNoCi: non-github → false even with zero workflows", () => {
  expect(repoHasNoCi("gitea", 0)).toBe(false);
  expect(repoHasNoCi("local", 0)).toBe(false);
});

test("checksCleared: success always clears (noCi irrelevant)", () => {
  expect(checksCleared("success", false)).toBe(true);
  expect(checksCleared("success", true)).toBe(true);
});

test("checksCleared: none clears only when noCi", () => {
  expect(checksCleared("none", true)).toBe(true);
  expect(checksCleared("none", false)).toBe(false);
});

test("checksCleared: pending/failure never clear", () => {
  expect(checksCleared("pending", true)).toBe(false);
  expect(checksCleared("failure", true)).toBe(false);
});

test("checksCleared(checks, false) ≡ checks === 'success' (back-compat)", () => {
  for (const c of ["none", "pending", "success", "failure"] as const) {
    expect(checksCleared(c, false)).toBe(c === "success");
  }
});

test("repoHasNoCiCached: non-github short-circuits without a readdir", () => {
  // A path that doesn't exist would count 0 workflows, but non-github must still be false.
  expect(repoHasNoCiCached("gitea", "/no/such/repo")).toBe(false);
});

test("repoHasNoCiCached: memoizes within the TTL window", () => {
  let t = 0;
  const now = () => t;
  const repo = "/tmp/checks-gate-nonexistent-" + "memo"; // missing dir ⇒ count 0 ⇒ true (github)
  expect(repoHasNoCiCached("github", repo, now)).toBe(true);
  // Same answer on a cache hit; advancing past the TTL re-reads (still 0 → true).
  t = 1000;
  expect(repoHasNoCiCached("github", repo, now)).toBe(true);
  t = 120_000;
  expect(repoHasNoCiCached("github", repo, now)).toBe(true);
});

function repoWith(file: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "checks-gate-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", file), body);
  return dir;
}

test("repoHasNoCiCached: schedule/dispatch-only workflows ⇒ no CI (#3221)", () => {
  const dir = repoWith(
    "db-backup.yml",
    "on:\n  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:\n",
  );
  try {
    expect(repoHasNoCiCached("github", dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repoHasNoCiCached: a pull_request workflow ⇒ has CI", () => {
  const dir = repoWith("ci.yml", "on: [pull_request]\n");
  try {
    expect(repoHasNoCiCached("github", dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
