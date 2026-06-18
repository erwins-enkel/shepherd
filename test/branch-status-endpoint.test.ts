import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeApp, clearBranchStatusCacheForTests, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import { config } from "../src/config";

// ── git fixture helpers ───────────────────────────────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function commit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", msg], { cwd: dir, stdio: "pipe", env: GIT_ENV });
}

let advanceCounter = 0;

/** Advance origin/main by one commit from a temporary second clone. */
function advanceOrigin(origin: string) {
  const other = mkdtempSync(join(tmpdir(), "shepherd-bs-other-"));
  try {
    execFileSync("git", ["clone", "-q", "--branch", "main", origin, other], { stdio: "pipe" });
    // Use a unique filename per call so successive advances don't no-op.
    commit(other, `advance-${++advanceCounter}.txt`, "advance", "advance origin/main");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other, stdio: "pipe" });
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}

// ── app harness ───────────────────────────────────────────────────────────────

function makeDeps(): AppDeps {
  return {
    store: {} as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
  };
}

function makeRequest(repo: string, branch: string): Request {
  return new Request(
    `http://localhost/api/branch-status?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
  );
}

// ── fixtures ──────────────────────────────────────────────────────────────────

// We need the repo inside config.repoRoot so safeRepoDir accepts it.
// Strategy: create a symlink-or-subdir inside config.repoRoot that points at
// the real repo in /tmp. Instead, we use mkdtempSync inside repoRoot directly
// for the fixture — but our git fixture helpers use /tmp for speed. We resolve
// this by having the clone live inside config.repoRoot.

let tmpRootInRepoRoot: string;
let origin: string;
let repo: string; // lives inside config.repoRoot

beforeEach(() => {
  clearBranchStatusCacheForTests();

  // Create a clean subdirectory inside repoRoot to hold the clone.
  tmpRootInRepoRoot = mkdtempSync(join(config.repoRoot, "shepherd-bs-test-"));

  // Build origin in /tmp (fast), clone into repoRoot subdir.
  origin = mkdtempSync(join(tmpdir(), "shepherd-bs-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });

  const seed = mkdtempSync(join(tmpdir(), "shepherd-bs-seed-"));
  execFileSync("git", ["init", "-q", "-b", "main", seed], { stdio: "pipe" });
  commit(seed, "a.txt", "1", "init");
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: seed, stdio: "pipe" });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed, stdio: "pipe" });
  rmSync(seed, { recursive: true, force: true });

  repo = join(tmpRootInRepoRoot, "repo");
  execFileSync("git", ["clone", "-q", "--single-branch", "--branch", "main", origin, repo], {
    stdio: "pipe",
  });
});

afterEach(() => {
  clearBranchStatusCacheForTests();
  rmSync(tmpRootInRepoRoot, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

test("GET /api/branch-status: origin ahead → behind>0, ahead=0, diverged=false", async () => {
  // Advance origin/main so local main is behind.
  advanceOrigin(origin);

  const app = makeApp(makeDeps());
  const res = await app.fetch(makeRequest(repo, "main"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.behind).toBeGreaterThan(0);
  expect(body.ahead).toBe(0);
  expect(body.diverged).toBe(false);
  expect(body.hasUpstream).toBe(true);
  expect(body.localExists).toBe(true);
  // Verify the five-field shape only — shas must NOT appear.
  expect(Object.keys(body).sort()).toEqual(
    ["ahead", "behind", "diverged", "hasUpstream", "localExists"].sort(),
  );
});

test("GET /api/branch-status: invalid branch ('--evil') → 400 { error: 'invalid branch' }", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request(
      `http://localhost/api/branch-status?repo=${encodeURIComponent(repo)}&branch=--evil`,
    ),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid branch");
});

test("GET /api/branch-status: missing branch param → 400 { error: 'invalid branch' }", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request(`http://localhost/api/branch-status?repo=${encodeURIComponent(repo)}`),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid branch");
});

test("GET /api/branch-status: repo outside repoRoot → 400 { error: 'invalid repo' }", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://localhost/api/branch-status?repo=%2Fetc&branch=main"),
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("invalid repo");
});

test("GET /api/branch-status: TTL cache — second call returns cached value (skips fetch)", async () => {
  // Advance origin/main so first call sees behind=1.
  advanceOrigin(origin);

  const app = makeApp(makeDeps());

  // First call — populates cache with behind=1.
  const res1 = await app.fetch(makeRequest(repo, "main"));
  expect(res1.status).toBe(200);
  const body1 = await res1.json();
  expect(body1.behind).toBeGreaterThan(0);
  const cachedBehind = body1.behind;

  // Advance origin/main again — if the cache were bypassed, behind would increase.
  advanceOrigin(origin);

  // Second call — must return the same cached value (behind unchanged), proving the
  // network fetch was skipped and the cached result was served.
  const res2 = await app.fetch(makeRequest(repo, "main"));
  expect(res2.status).toBe(200);
  const body2 = await res2.json();
  expect(body2.behind).toBe(cachedBehind); // stale cache — new commit not reflected
});
