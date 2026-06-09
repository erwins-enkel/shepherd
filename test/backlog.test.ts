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
  const run: GhRunner = async (args) => {
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
  const run: GhRunner = async () => "";
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
  const run: GhRunner = async (args) => {
    calls.push(args);
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

  const run: GhRunner = async (args) => {
    // With gh variables, owner is passed as a separate -F arg: "owner=<value>"
    const ownerArg = args.find((a) => a.startsWith("owner=")) ?? "";
    if (ownerArg === "owner=bad") throw new Error("gh auth failed");
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

  const run: GhRunner = async () => {
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

// 7. TTL expiry: second call after TTL elapses re-invokes the runner
test("CountsService: TTL expiry — call after 60s window re-fetches from runner", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ttl-expire"), "https://github.com/o/ttl-expire");
  const forges: ForgeMap = {};

  const graphqlResponse = JSON.stringify({
    data: { repository: { issues: { totalCount: 5 }, pullRequests: { totalCount: 1 } } },
  });
  const { run, calls } = fakeRunner(graphqlResponse);
  const svc = new CountsService(forges, run);

  // First fetch — populates cache
  await svc.counts(repoDir);

  // Backdate the cache entry's `at` field to simulate TTL expiry (> 60 000 ms ago)
  const entry = (svc as any).cache.get(repoDir);
  entry.at = Date.now() - 61_000;

  // Second fetch — cache is stale, runner should be called again
  await svc.counts(repoDir);

  const graphqlCalls = calls.filter((c) => c.includes("graphql"));
  expect(graphqlCalls.length).toBe(2);
});

// 8b. refresh() bypasses the TTL — the warmer re-fetches even within the window
test("CountsService: refresh re-invokes the runner within the TTL window", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-refresh"), "https://github.com/o/refresh");
  const forges: ForgeMap = {};

  const graphqlResponse = JSON.stringify({
    data: { repository: { issues: { totalCount: 9 }, pullRequests: { totalCount: 4 } } },
  });
  const { run, calls } = fakeRunner(graphqlResponse);
  const svc = new CountsService(forges, run);

  await svc.counts(repoDir); // populate cache
  await svc.refresh(repoDir); // force a refetch despite a fresh entry

  const graphqlCalls = calls.filter((c) => c.includes("graphql"));
  expect(graphqlCalls.length).toBe(2);
});

// 8c. async runner: GitHub path awaits a promise-returning runner
test("CountsService: works with an async (promise-returning) runner", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-async"), "https://github.com/o/async");
  const forges: ForgeMap = {};

  const run = async () =>
    JSON.stringify({
      data: { repository: { issues: { totalCount: 11 }, pullRequests: { totalCount: 6 } } },
    });
  const svc = new CountsService(forges, run);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBe(11);
  expect(result.openPRs).toBe(6);
});

// 8b-ii. refresh() keeps the last-known-good value when a warm fails
test("CountsService: refresh preserves last-known-good on transient failure", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-preserve"), "https://github.com/o/preserve");
  const forges: ForgeMap = {};

  let fail = false;
  const run = async (): Promise<string> => {
    if (fail) throw new Error("gh flake");
    return JSON.stringify({
      data: { repository: { issues: { totalCount: 8 }, pullRequests: { totalCount: 2 } } },
    });
  };
  const svc = new CountsService(forges, run);

  const good = await svc.counts(repoDir); // populate cache with a good value
  expect(good.openIssues).toBe(8);

  fail = true;
  const afterFlake = await svc.refresh(repoDir); // warm fails → keep last-known-good
  expect(afterFlake.openIssues).toBe(8);
  expect(afterFlake.openPRs).toBe(2);

  // and a subsequent request (within TTL) still sees the preserved value, not null
  const stillGood = await svc.counts(repoDir);
  expect(stillGood.openIssues).toBe(8);
});

// 8b-iii. counts() (request path) still surfaces null on failure — preserve is refresh-only
test("CountsService: request-path failure still yields null (no preserve)", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-no-preserve"), "https://github.com/o/nopreserve");
  const forges: ForgeMap = {};

  const run = async (): Promise<string> => {
    throw new Error("down");
  };
  const svc = new CountsService(forges, run);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBeNull();
});

// 8d. concurrency cap: many concurrent fetches never exceed the configured ceiling
test("CountsService: caps concurrent fetches at maxConcurrency", async () => {
  const dirs: string[] = [];
  for (let i = 0; i < 12; i++) {
    dirs.push(gitInit(join(tmpBase, `cc-${i}`), `https://github.com/o/r${i}`));
  }
  const forges: ForgeMap = {};

  let active = 0;
  let peak = 0;
  const run = async (): Promise<string> => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return JSON.stringify({
      data: { repository: { issues: { totalCount: 1 }, pullRequests: { totalCount: 1 } } },
    });
  };
  const svc = new CountsService(forges, run, fetch, 3); // cap = 3

  await Promise.all(dirs.map((d) => svc.counts(d)));

  expect(peak).toBeLessThanOrEqual(3); // never burst past the cap
  expect(peak).toBeGreaterThan(1); // but still genuinely parallel, not serialized
});

// 9. Non-forge repo (no git remote) → null counts
test("CountsService: repo with no origin → null counts (not a throw)", async () => {
  const repoDir = join(tmpBase, "no-remote");
  mkdirSync(repoDir);
  spawnSync("git", ["init", "-q"], { cwd: repoDir });
  // No remote set

  const forges: ForgeMap = {};
  const run: GhRunner = async () => "";
  const svc = new CountsService(forges, run);

  const result = await svc.counts(repoDir);
  expect(result.openIssues).toBeNull();
  expect(result.openPRs).toBeNull();
});

// 10. CI rollup: graphql FAILURE state → ciStatus "failure"
test("CountsService: maps default-branch statusCheckRollup FAILURE → ciStatus failure", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ci-fail"), "https://github.com/o/ci-fail");
  const { run } = fakeRunner(
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 1 },
          pullRequests: { totalCount: 0 },
          defaultBranchRef: { target: { statusCheckRollup: { state: "FAILURE" } } },
        },
      },
    }),
  );
  const svc = new CountsService({}, run);
  const result = await svc.counts(repoDir);
  expect(result.ciStatus).toBe("failure");
});

// 11. CI rollup: ERROR also maps to "failure" (errored CI is not healthy)
test("CountsService: maps statusCheckRollup ERROR → ciStatus failure", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ci-error"), "https://github.com/o/ci-error");
  const { run } = fakeRunner(
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          defaultBranchRef: { target: { statusCheckRollup: { state: "ERROR" } } },
        },
      },
    }),
  );
  const svc = new CountsService({}, run);
  expect((await svc.counts(repoDir)).ciStatus).toBe("failure");
});

// 12. CI rollup: SUCCESS → "success", PENDING → "pending"
test("CountsService: maps SUCCESS → success and PENDING → pending", async () => {
  const okDir = gitInit(join(tmpBase, "gh-ci-ok"), "https://github.com/o/ci-ok");
  const pendDir = gitInit(join(tmpBase, "gh-ci-pend"), "https://github.com/o/ci-pend");
  const mk = (state: string) =>
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          defaultBranchRef: { target: { statusCheckRollup: { state } } },
        },
      },
    });
  const okSvc = new CountsService({}, async () => mk("SUCCESS"));
  const pendSvc = new CountsService({}, async () => mk("PENDING"));
  expect((await okSvc.counts(okDir)).ciStatus).toBe("success");
  expect((await pendSvc.counts(pendDir)).ciStatus).toBe("pending");
});

// 13. CI rollup: absent (no rollup / no default branch) → ciStatus null
test("CountsService: missing statusCheckRollup → ciStatus null", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ci-none"), "https://github.com/o/ci-none");
  const { run } = fakeRunner(
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 2 },
          pullRequests: { totalCount: 1 },
          defaultBranchRef: { target: { statusCheckRollup: null } },
        },
      },
    }),
  );
  const svc = new CountsService({}, run);
  const result = await svc.counts(repoDir);
  expect(result.ciStatus).toBeNull();
  expect(result.openIssues).toBe(2); // counts still parsed
});

// 14. Gitea repos have no Actions rollup → ciStatus null
test("CountsService: Gitea repo → ciStatus null", async () => {
  const repoDir = gitInit(join(tmpBase, "gitea-ci"), "https://git.example.com/team/proj");
  const forges: ForgeMap = {
    "git.example.com": { type: "gitea", baseUrl: "https://git.example.com", token: "tok" },
  };
  const { fn } = fakeFetch({ open_issues_count: 5, open_pr_counter: 1 });
  const svc = new CountsService(forges, async () => "", fn);
  expect((await svc.counts(repoDir)).ciStatus).toBeNull();
});
