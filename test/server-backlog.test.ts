/**
 * Integration tests for GET /api/backlog (handleBacklog in src/server.ts).
 *
 * handleBacklog calls listRepos(config.repoRoot) which scans one level deep
 * in the actual repoRoot. We must therefore create test repos as direct
 * children of config.repoRoot, and make resolveForge return null for every
 * repo path that isn't one of ours so that other repos in the tree are
 * silently excluded.
 *
 * Pattern mirrors test/server-issues.test.ts.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge } from "../src/forge/types";
import type { RepoCounts } from "../src/backlog";
import { config } from "../src/config";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * repoA and repoB are direct children of config.repoRoot, so listRepos() finds
 * them.  repoNonForge is also a direct child but resolveForge returns null for
 * it, which is the forge-exclusion case we want to test.
 *
 * Naming avoids collisions between parallel test runs via mkdtempSync prefixes.
 */
let repoA: string;
let repoB: string;
let repoNonForge: string;

beforeEach(() => {
  // Each test gets fresh, uniquely-named directories so they never cross-contaminate.
  repoA = mkdtempSync(join(config.repoRoot, "blt-alpha-"));
  repoB = mkdtempSync(join(config.repoRoot, "blt-beta-"));
  repoNonForge = mkdtempSync(join(config.repoRoot, "blt-zeta-"));
});

afterEach(() => {
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
  rmSync(repoNonForge, { recursive: true, force: true });
});

function fakeForge(slug: string, kind: "github" | "gitea" = "github"): GitForge {
  return {
    kind,
    slug,
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
}

/**
 * Build AppDeps. `resolveForge` recognises only repoA and repoB; all others
 * (including repoNonForge and whatever else is in repoRoot) get null.
 * `backlogCounts` maps repoPath → RepoCounts; `lastUsed` maps repoPath → ms.
 */
function makeDeps(
  backlogCounts: Record<string, RepoCounts>,
  lastUsed: Record<string, number> = {},
  overrideForge?: AppDeps["resolveForge"],
): AppDeps {
  return {
    store: {
      lastUsedByRepo: () => lastUsed,
    } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge:
      overrideForge ??
      ((path) => {
        if (path === repoA) return fakeForge("org/alpha");
        if (path === repoB) return fakeForge("org/beta");
        return null;
      }),
    backlog: {
      counts: async (path: string): Promise<RepoCounts> =>
        backlogCounts[path] ?? { openIssues: null, openPRs: null },
    },
  };
}

function req(): Request {
  return new Request("http://localhost/api/backlog");
}

// ── tests ───────────────────────────────────────────────────────────────────

test("GET /api/backlog returns 200 with projects array", async () => {
  const app = makeApp(
    makeDeps({ [repoA]: { openIssues: 5, openPRs: 1 }, [repoB]: { openIssues: 2, openPRs: 0 } }),
  );
  const res = await app.fetch(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.projects)).toBe(true);
});

test("GET /api/backlog excludes non-forge repos", async () => {
  const app = makeApp(makeDeps({ [repoA]: { openIssues: 1, openPRs: 0 } }));
  const body = await app.fetch(req()).then((r) => r.json());
  const paths = body.projects.map((p: { path: string }) => p.path);
  // repoNonForge must not appear
  expect(paths).not.toContain(repoNonForge);
  // Our two forge repos appear
  expect(paths).toContain(repoA);
  expect(paths).toContain(repoB);
});

test("GET /api/backlog sorts by openIssues descending, null last", async () => {
  const app = makeApp(
    makeDeps({
      [repoA]: { openIssues: 3, openPRs: 0 },
      [repoB]: { openIssues: null, openPRs: null },
    }),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  const projects = body.projects as { path: string; openIssues: number | null }[];
  const idxA = projects.findIndex((p) => p.path === repoA);
  const idxB = projects.findIndex((p) => p.path === repoB);
  // repoA (3) should come before repoB (null)
  expect(idxA).toBeGreaterThanOrEqual(0);
  expect(idxB).toBeGreaterThanOrEqual(0);
  expect(idxA).toBeLessThan(idxB);
});

test("GET /api/backlog sort: higher issue count before lower", async () => {
  const app = makeApp(
    makeDeps({
      [repoA]: { openIssues: 1, openPRs: 0 },
      [repoB]: { openIssues: 10, openPRs: 0 },
    }),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  const projects = body.projects as { path: string }[];
  const idxA = projects.findIndex((p) => p.path === repoA);
  const idxB = projects.findIndex((p) => p.path === repoB);
  // B (10) comes before A (1)
  expect(idxB).toBeLessThan(idxA);
});

test("GET /api/backlog pinnedPath = max lastUsedAt", async () => {
  const app = makeApp(
    makeDeps(
      { [repoA]: { openIssues: 5, openPRs: 0 }, [repoB]: { openIssues: 2, openPRs: 0 } },
      { [repoA]: 100, [repoB]: 200 }, // B was used most recently
    ),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  expect(body.pinnedPath).toBe(repoB);
});

test("GET /api/backlog pinnedPath is included in projects array", async () => {
  const app = makeApp(
    makeDeps(
      { [repoA]: { openIssues: 5, openPRs: 0 }, [repoB]: { openIssues: 2, openPRs: 0 } },
      { [repoA]: 100, [repoB]: 200 },
    ),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  const paths = body.projects.map((p: { path: string }) => p.path);
  expect(paths).toContain(body.pinnedPath);
});

test("GET /api/backlog null counts pass through as null, not 0", async () => {
  const app = makeApp(makeDeps({ [repoA]: { openIssues: null, openPRs: null } }));
  const body = await app.fetch(req()).then((r) => r.json());
  const projA = body.projects.find((p: { path: string }) => p.path === repoA);
  expect(projA).toBeDefined();
  expect(projA.openIssues).toBeNull();
  expect(projA.openPRs).toBeNull();
});

test("GET /api/backlog totals skip null counts", async () => {
  const app = makeApp(
    makeDeps({
      [repoA]: { openIssues: 5, openPRs: 2 },
      [repoB]: { openIssues: null, openPRs: null },
    }),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  // Only non-null values count toward totals
  expect(body.totals.openIssues).toBe(5);
  expect(body.totals.openPRs).toBe(2);
});

test("GET /api/backlog totals sum non-null from both repos", async () => {
  const app = makeApp(
    makeDeps({
      [repoA]: { openIssues: 4, openPRs: 1 },
      [repoB]: { openIssues: 6, openPRs: 3 },
    }),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  expect(body.totals.openIssues).toBe(10);
  expect(body.totals.openPRs).toBe(4);
});

test("GET /api/backlog with deps.backlog absent → empty payload", async () => {
  const deps: AppDeps = {
    store: { lastUsedByRepo: () => ({}) } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    // no backlog
  };
  const app = makeApp(deps);
  const res = await app.fetch(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    pinnedPath: null,
    projects: [],
    totals: { openIssues: 0, openPRs: 0 },
  });
});

test("GET /api/backlog dedupes worktrees of the same repo by forge slug", async () => {
  // repoA and repoB resolve to the SAME forge slug — e.g. two worktrees/clones
  // of one GitHub repo. They must collapse to a single project entry.
  const dupForge: AppDeps["resolveForge"] = (path) =>
    path === repoA || path === repoB ? fakeForge("org/dup") : null;
  const app = makeApp(
    makeDeps(
      { [repoA]: { openIssues: 7, openPRs: 2 }, [repoB]: { openIssues: 7, openPRs: 2 } },
      { [repoA]: 100, [repoB]: 200 }, // repoB used most recently → the kept representative
      dupForge,
    ),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  const dup = body.projects.filter((p: { slug: string }) => p.slug === "org/dup");
  // collapsed to a single entry...
  expect(dup.length).toBe(1);
  // ...pointing at the most-recently-used directory...
  expect(dup[0].path).toBe(repoB);
  // ...and counts are not double-counted in the totals
  expect(body.totals.openIssues).toBe(7);
  expect(body.totals.openPRs).toBe(2);
});

test("GET /api/backlog keeps repos with distinct slugs separate", async () => {
  const app = makeApp(
    makeDeps({ [repoA]: { openIssues: 1, openPRs: 0 }, [repoB]: { openIssues: 1, openPRs: 0 } }),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  const paths = body.projects.map((p: { path: string }) => p.path);
  // org/alpha and org/beta are different repos → both remain
  expect(paths).toContain(repoA);
  expect(paths).toContain(repoB);
});

test("GET /api/backlog pinnedPath falls back to first sorted project when no lastUsedAt", async () => {
  const app = makeApp(
    makeDeps(
      {
        [repoA]: { openIssues: 10, openPRs: 0 },
        [repoB]: { openIssues: 1, openPRs: 0 },
      },
      {}, // no lastUsedAt for any repo
    ),
  );
  const body = await app.fetch(req()).then((r) => r.json());
  // With no lastUsedAt, pinnedPath falls back to the first project after sort (most issues = repoA)
  expect(body.pinnedPath).toBe(repoA);
});
