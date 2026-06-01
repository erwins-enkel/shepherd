/**
 * Unit tests for CountsService (src/backlog.ts).
 *
 * Forge resolution shells out to `git remote get-url origin`, so each test
 * that exercises GitHub/Gitea paths sets up a temp git repo with the desired
 * remote URL. This mirrors how test/forge-detect.test.ts handles git-backed
 * detection.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { CountsService } from "../src/backlog";
import type { GhRunner } from "../src/forge/github";
import type { ForgeMap } from "../src/forge/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "backlog-test-"));
}

/**
 * Initialise a bare git repo at `dir` with `origin` set to `remoteUrl`.
 * Returns `dir` for convenience.
 */
function gitInit(dir: string, remoteUrl: string): string {
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  return dir;
}

/** A recording fake GhRunner. */
function fakeRunner(response: string): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    return response;
  };
  return { run, calls };
}

/** Build a fake fetch that always returns the given JSON object with status 200. */
function fakeFetch(json: unknown) {
  let callCount = 0;
  const fn = async (): Promise<Response> => {
    callCount++;
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fn: fn as unknown as typeof fetch,
    get callCount() {
      return callCount;
    },
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

let tmpBase: string;

beforeEach(() => {
  tmpBase = makeTmpDir();
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// 1. GitHub repo: runner returns canned graphql JSON → {openIssues:24, openPRs:3}
test("CountsService: GitHub repo returns openIssues and openPRs from graphql", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-repo"), "https://github.com/myorg/myrepo");
  const forges: ForgeMap = {}; // github.com is auto-detected

  const graphqlResponse = JSON.stringify({
    data: {
      repository: {
        issues: { totalCount: 24 },
        pullRequests: { totalCount: 3 },
      },
    },
  });
  const { run } = fakeRunner(graphqlResponse);
  const svc = new CountsService(forges, run);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBe(24);
  expect(result.openPRs).toBe(3);
});

// 2. Gitea repo: fetchFn returns gitea API shape → {openIssues:5, openPRs:1}
test("CountsService: Gitea repo returns openIssues and openPRs from REST API", async () => {
  const repoDir = gitInit(join(tmpBase, "gitea-repo"), "https://git.example.com/team/proj");
  const forges: ForgeMap = {
    "git.example.com": {
      type: "gitea",
      baseUrl: "https://git.example.com",
      token: "tok",
    },
  };

  const { fn } = fakeFetch({ open_issues_count: 5, open_pr_counter: 1 });
  const run: GhRunner = () => "";
  const svc = new CountsService(forges, run, fn);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBe(5);
  expect(result.openPRs).toBe(1);
});

// 3. 60s TTL: two calls within the window invoke runner ONCE
test("CountsService: TTL caches result — second call within window skips runner", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ttl"), "https://github.com/o/r");
  const forges: ForgeMap = {};

  const graphqlResponse = JSON.stringify({
    data: { repository: { issues: { totalCount: 10 }, pullRequests: { totalCount: 2 } } },
  });
  const { run, calls } = fakeRunner(graphqlResponse);
  const svc = new CountsService(forges, run);

  await svc.counts(repoDir);
  await svc.counts(repoDir);

  // Runner should only have been called once (the "api graphql" call)
  const graphqlCalls = calls.filter((c) => c.includes("graphql"));
  expect(graphqlCalls.length).toBe(1);
});

// 4. Single-flight: two concurrent calls share one in-flight request
test("CountsService: single-flight — concurrent calls share one in-flight promise", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-sf"), "https://github.com/o/r2");
  const forges: ForgeMap = {};

  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    // Synchronously block until we resolve — simulate a slow response
    // We actually need sync return from GhRunner, so we return immediately
    // but track that it was only invoked once.
    return JSON.stringify({
      data: { repository: { issues: { totalCount: 7 }, pullRequests: { totalCount: 0 } } },
    });
  };

  // Fire two concurrent calls before the first can cache
  // We need to clear any cache first by using a fresh service
  const svc = new CountsService(forges, run);
  const [r1, r2] = await Promise.all([svc.counts(repoDir), svc.counts(repoDir)]);

  expect(r1.openIssues).toBe(7);
  expect(r2.openIssues).toBe(7);
  // graphql runner invoked exactly once
  const graphqlCalls = calls.filter((c) => c.includes("graphql"));
  expect(graphqlCalls.length).toBe(1);
});

// 5. Fault isolation: a runner that throws → null counts; sibling still resolves
test("CountsService: fault isolation — throwing runner yields null counts, not 0", async () => {
  const failDir = gitInit(join(tmpBase, "fail-repo"), "https://github.com/bad/repo");
  const goodDir = gitInit(join(tmpBase, "good-repo"), "https://github.com/good/repo");
  const forges: ForgeMap = {};

  const run: GhRunner = (args) => {
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (q.includes('"bad"')) throw new Error("gh auth failed");
    return JSON.stringify({
      data: { repository: { issues: { totalCount: 3 }, pullRequests: { totalCount: 1 } } },
    });
  };

  const svc = new CountsService(forges, run);

  const failResult = await svc.counts(failDir);
  expect(failResult.openIssues).toBeNull();
  expect(failResult.openPRs).toBeNull();

  const goodResult = await svc.counts(goodDir);
  expect(goodResult.openIssues).toBe(3);
  expect(goodResult.openPRs).toBe(1);
});

// 6. Failure never coerces to 0 — explicitly null
test("CountsService: failure yields null not 0", async () => {
  const repoDir = gitInit(join(tmpBase, "throws"), "https://github.com/boom/repo");
  const forges: ForgeMap = {};

  const run: GhRunner = () => {
    throw new Error("network error");
  };
  const svc = new CountsService(forges, run);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBeNull();
  expect(result.openPRs).toBeNull();
  // Explicitly not 0
  expect(result.openIssues).not.toBe(0);
  expect(result.openPRs).not.toBe(0);
});

// 7. Non-forge repo (no git remote) → null counts
test("CountsService: repo with no origin → null counts (not a throw)", async () => {
  const repoDir = join(tmpBase, "no-remote");
  mkdirSync(repoDir);
  spawnSync("git", ["init", "-q"], { cwd: repoDir });
  // No remote set

  const forges: ForgeMap = {};
  const run: GhRunner = () => "";
  const svc = new CountsService(forges, run);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBeNull();
  expect(result.openPRs).toBeNull();
});
