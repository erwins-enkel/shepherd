/**
 * Cross-consumer snapshot sharing: poller warms → PRs tab reuses, one fetch.
 *
 * The whole point of OpenPrSnapshotService is that the pr-poller and GET /api/prs
 * share one cached `gh pr list` fetch per repo. They reach the cache via
 * independently-resolved forges: the poller resolves a forge from session.repoPath;
 * /api/prs resolves a forge from safeRepoDir(repo, repoRoot). The service keys by
 * forge.slug, so sharing only works if both resolutions yield the SAME slug.
 *
 * A plain single-forge call-count test passes even when the keys secretly mismatch
 * (same forge instance → same key trivially). This test exercises BOTH real code
 * paths with SEPARATE forge instances and asserts the underlying fetch fires ONCE.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { PrPoller } from "../src/pr-poller";
import { OpenPrSnapshotService } from "../src/open-pr-snapshot";
import { makeApp, type AppDeps } from "../src/server";
import type { GitForge, PrStatus, PullRequest, OpenPrSnapshot } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import { config } from "../src/config";

// ── Canned data ───────────────────────────────────────────────────────────────

/** Single slug shared by both forge instances — the key the service normalises on. */
const SLUG = "owner/repo";

const CANNED_PR: PullRequest = {
  number: 42,
  title: "feat: cross-consumer test",
  url: "https://github.com/owner/repo/pull/42",
  author: "alice",
  kind: "regular",
  createdAt: 1_700_000_000_000,
  isDraft: false,
  mergeable: true,
  checks: "success",
  jobs: [],
};

const OPEN: PrStatus = { state: "open", number: 42, checks: "success", deployConfigured: false };
const NONE: PrStatus = { state: "none", checks: "none", deployConfigured: false };

function cannedSnapshot(branches: string[]): OpenPrSnapshot {
  const statuses = new Map<string, PrStatus>();
  statuses.set(branches[0]!, OPEN);
  for (let i = 1; i < branches.length; i++) statuses.set(branches[i]!, NONE);
  return { prs: [CANNED_PR], statuses, capped: false };
}

// ── Forge builders ────────────────────────────────────────────────────────────

/**
 * Forge used by the POLLER. Has listOpenPrSnapshot + countOpenPrs so the poller
 * calls snapshotSvc.refresh(). fetchCount tracks underlying listOpenPrSnapshot calls.
 */
function makePollerForge(snapshot: OpenPrSnapshot): { forge: GitForge; fetchCount: { n: number } } {
  const fetchCount = { n: 0 };
  const forge: GitForge = {
    kind: "github",
    slug: SLUG,
    mergeMethod: "squash",
    deployWorkflow: null,
    isFork: false,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => NONE,
    listOpenPrSnapshot: async () => {
      fetchCount.n++;
      return snapshot;
    },
    countOpenPrs: async () => 1, // < 200 and ≤ batchOpenRatio(2) × sessionCount(2) = 4
    openPr: async () => NONE,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return { forge, fetchCount };
}

/**
 * A SEPARATE forge instance with the SAME slug — resolved independently by the
 * server's resolveForge. Its listOpenPrSnapshot spy must read 0 when the cache is
 * warm; a non-zero count means the slug key didn't match and a redundant fetch occurred.
 */
function makeServerForge(): { forge: GitForge; fetchCount: { n: number } } {
  const fetchCount = { n: 0 };
  const forge: GitForge = {
    kind: "github",
    slug: SLUG, // same slug → must share the cache entry
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => NONE,
    listOpenPrSnapshot: async () => {
      fetchCount.n++;
      // Should never be reached; if it is, the slug-keyed cache missed.
      return { prs: [], statuses: new Map(), capped: false };
    },
    countOpenPrs: async () => 0,
    openPr: async () => NONE,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return { forge, fetchCount };
}

// ── Session base ──────────────────────────────────────────────────────────────

const BASE_SESSION = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
};

// ── Temp dir (server-prs pattern) ─────────────────────────────────────────────

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-cross-consumer-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── Main assertion ────────────────────────────────────────────────────────────

test("poller-warmed snapshot is served to GET /api/prs with zero additional fetches", async () => {
  /**
   * Frozen clock: the entry written by refresh() never expires before get() reads
   * it. Without this, a real Date.now() could theoretically expire within the test.
   */
  const svc = new OpenPrSnapshotService(() => 0);

  const branches = ["shepherd/a", "shepherd/b"];
  const snapshot = cannedSnapshot(branches);

  // ── Step 1: poller sweep — real code calls snapshotSvc.refresh(pollerForge) ──
  //
  // PrPoller.batchForRepo enters the snapshot path when:
  //   count ≥ 2 (sessions with a branch in this repo)  ✓ (2 sessions below)
  //   !forge.isFork                                     ✓
  //   forge.countOpenPrs present                        ✓
  //   forge.listOpenPrSnapshot present                  ✓
  //   p < 200 AND p ≤ batchOpenRatio × count            ✓ (1 ≤ 2×2=4)
  //   snapshotSvc present                               ✓ (injected as last param)
  const { forge: pollerForge, fetchCount: pollerFetch } = makePollerForge(snapshot);
  const store = new SessionStore(":memory:");
  store.create({ ...BASE_SESSION, branch: branches[0]! });
  store.create({ ...BASE_SESSION, branch: branches[1]! }); // 2nd session satisfies count≥2 floor

  const poller = new PrPoller(
    store,
    () => pollerForge,
    () => {},
    120_000, // intervalMs
    1000, // pollDelayMs
    () => null, // reconcileBranch
    15_000, // fastIntervalMs
    8, // fastBatch
    () => true, // ownsPr
    () => true, // warm
    () => false, // rateLimited
    300_000, // idleIntervalMs
    300_000, // transientMaxMs
    2, // batchOpenRatio (default)
    600_000, // noneRecheckMs
    svc, // snapshotSvc — LAST param; the real shared service
  );

  await poller.tick();

  // The poller's real batchForRepo called snapshotSvc.refresh(pollerForge), which
  // invoked pollerForge.listOpenPrSnapshot() exactly once.
  expect(pollerFetch.n).toBe(1);

  // ── Step 2: GET /api/prs via a SEPARATE forge instance with the same slug ──
  //
  // This mirrors prod: the server resolves its own forge object from the request's
  // repo param. The forge is a different instance than what the poller used, so a
  // slug-vs-repoPath key mismatch would cause a cache miss and drive a second fetch.
  const { forge: serverForge, fetchCount: serverFetch } = makeServerForge();
  const deps: AppDeps = {
    store: { isEpicIntegratedChild: () => false } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => serverForge,
    openPrSnapshot: svc, // THE SAME service instance the poller used
  };
  const app = makeApp(deps);
  const res = await app.fetch(
    new Request(`http://localhost/api/prs?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();

  // ── Core assertions ───────────────────────────────────────────────────────────

  // The response carries the poller-warmed PRs — not an empty fallback.
  expect(body.prs).toEqual([CANNED_PR]);

  // The server forge's listOpenPrSnapshot was never invoked: the tab read the
  // poller-warmed cache entry via svc.get(serverForge) → slug hit → no new fetch.
  expect(serverFetch.n).toBe(0);

  // Total underlying listOpenPrSnapshot fetches across BOTH forge instances = 1.
  // If the slug key normalisation were broken (e.g. keyed by repoPath instead),
  // the tab would refetch and this sum would be 2.
  expect(pollerFetch.n + serverFetch.n).toBe(1);
});

// ── Intentional asymmetry (documented; no test) ───────────────────────────────
//
// The REVERSE direction (tab warms via get() → poller reuses) intentionally does NOT
// share a fetch: PrPoller.batchForRepo calls snapshotSvc.refresh(), which always
// fetches fresh regardless of any TTL-warm entry the tab may have written. This is by
// design — the poller drives merge/handoff decisions and must never act on a stale read.
// Only the poller→tab direction shares; do not "fix" the asymmetry.
