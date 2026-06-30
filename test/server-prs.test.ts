import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, MergeInput, OpenPrSnapshot, PullRequest } from "../src/forge/types";
import { DEPENDABOT_REBASE_COMMAND, EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import { OpenPrSnapshotService } from "../src/open-pr-snapshot";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-prs-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const PR: PullRequest = {
  number: 12,
  title: "feat: thing",
  url: "https://github.com/team/proj/pull/12",
  author: "alice",
  kind: "regular",
  createdAt: 1_700_000_000_000,
  isDraft: false,
  mergeable: true,
  checks: "success",
  jobs: [{ name: "CI / test", state: "success", url: "https://gh/job/1" }],
  latestReview: { state: "approved", author: "bob", submittedAt: 1_700_000_100_000 },
};

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "github",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [PR],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
    ...over,
  };
}

function makeDeps(resolveForge: AppDeps["resolveForge"]): AppDeps {
  return {
    store: { isEpicIntegratedChild: () => false } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge,
  };
}

function getReq(repo: string): Request {
  return new Request(`http://localhost/api/prs?repo=${encodeURIComponent(repo)}`);
}

function mergeReq(body: unknown): Request {
  return new Request("http://localhost/api/prs/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rebaseReq(body: unknown): Request {
  return new Request("http://localhost/api/prs/dependabot-rebase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /api/prs resolves via the forge → {slug, prs}", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.slug).toBe("team/proj");
  expect(body.prs).toEqual([PR]);
});

test("GET /api/prs with no forge → {slug:null, prs:[]}", async () => {
  const app = makeApp(makeDeps(() => null));
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({ slug: null, webUrl: null, prs: [] });
});

test("GET /api/prs swallows forge errors → {slug, prs:[]}", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listPullRequests: async () => {
          throw new Error("gh not authed");
        },
      }),
    ),
  );
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({ slug: "team/proj", webUrl: null, prs: [] });
});

test("GET /api/prs includes forge webUrl in response", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ webUrl: "https://github.com/team/proj" })));
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  expect((await res.json()).webUrl).toBe("https://github.com/team/proj");
});

test("GET /api/prs?repo outside root → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(getReq("/etc"));
  expect(res.status).toBe(400);
});

test("POST /api/prs/merge merges the PR by number, defaulting method + deleteBranch", async () => {
  let merged: { number: number; opts: MergeInput } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        merge: async (number, opts) => {
          merged = { number, opts };
        },
      }),
    ),
  );
  const res = await app.fetch(mergeReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(merged!.number).toBe(12);
  expect(merged!.opts).toEqual({ method: "squash", deleteBranch: true });
});

test("POST /api/prs/merge refreshes the backlog for the repo so counters/headline drop the PR", async () => {
  const refreshed: string[] = [];
  const deps = makeDeps(() => fakeForge());
  deps.refreshBacklog = async (dir) => {
    refreshed.push(dir);
  };
  const app = makeApp(deps);
  const res = await app.fetch(mergeReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(200);
  // Fired synchronously before the response resolves (detached refetch).
  expect(refreshed).toEqual([repoDir]);
});

test("POST /api/prs/merge still succeeds when a backlog refresh rejects", async () => {
  const deps = makeDeps(() => fakeForge());
  deps.refreshBacklog = async () => {
    throw new Error("gh graphql flaked");
  };
  const app = makeApp(deps);
  const res = await app.fetch(mergeReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("POST /api/prs/merge without a number → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(mergeReq({ repo: repoDir }));
  expect(res.status).toBe(400);
});

test("POST /api/prs/merge surfaces forge failure → 502", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        merge: async () => {
          throw new Error("not mergeable");
        },
      }),
    ),
  );
  const res = await app.fetch(mergeReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("not mergeable");
});

test("POST /api/prs/dependabot-rebase posts @dependabot rebase by number", async () => {
  let commented: { number: number; body: string } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        comment: async (number, body) => {
          commented = { number, body };
        },
      }),
    ),
  );
  const res = await app.fetch(rebaseReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(commented!.number).toBe(12);
  expect(commented!.body).toBe(DEPENDABOT_REBASE_COMMAND);
});

// Security invariant: the comment body is authored server-side. A client cannot
// smuggle arbitrary text (or another bot command) through the request body.
test("POST /api/prs/dependabot-rebase ignores a client-supplied body, posting the fixed command", async () => {
  let posted: string | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        comment: async (_number, body) => {
          posted = body;
        },
      }),
    ),
  );
  const res = await app.fetch(
    rebaseReq({ repo: repoDir, number: 12, body: "@dependabot recreate" }),
  );
  expect(res.status).toBe(200);
  expect(posted!).toBe(DEPENDABOT_REBASE_COMMAND);
});

test("POST /api/prs/dependabot-rebase without a number → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ comment: async () => {} })));
  const res = await app.fetch(rebaseReq({ repo: repoDir }));
  expect(res.status).toBe(400);
});

test("POST /api/prs/dependabot-rebase on a forge without comment support → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(rebaseReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("comment");
});

test("POST /api/prs/dependabot-rebase surfaces forge failure → 502", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        comment: async () => {
          throw new Error("gh exploded");
        },
      }),
    ),
  );
  const res = await app.fetch(rebaseReq({ repo: repoDir, number: 12 }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("gh exploded");
});

// --- openPrSnapshot integration ---

const CACHED_PR: PullRequest = {
  number: 99,
  title: "feat: cached",
  url: "https://github.com/team/proj/pull/99",
  author: "carol",
  kind: "regular",
  createdAt: 1_700_001_000_000,
  isDraft: false,
  mergeable: true,
  checks: "success",
  jobs: [],
};

function fakeSnapshot(prs: PullRequest[]): OpenPrSnapshot {
  return { prs, statuses: new Map(), capped: false };
}

test("GET /api/prs uses snapshot prs when service returns a snapshot", async () => {
  let listCalled = false;
  const forge = fakeForge({
    listPullRequests: async () => {
      listCalled = true;
      return [PR];
    },
  });
  const deps = makeDeps(() => forge);
  deps.openPrSnapshot = {
    get: async () => fakeSnapshot([CACHED_PR]),
  };
  const app = makeApp(deps);
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.prs).toEqual([CACHED_PR]);
  expect(listCalled).toBe(false);
});

test("GET /api/prs falls back to listPullRequests when snapshot service returns null", async () => {
  let listCalled = false;
  const forge = fakeForge({
    listPullRequests: async () => {
      listCalled = true;
      return [PR];
    },
  });
  const deps = makeDeps(() => forge);
  deps.openPrSnapshot = {
    get: async () => null,
  };
  const app = makeApp(deps);
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.prs).toEqual([PR]);
  expect(listCalled).toBe(true);
});

test("GET /api/prs uses direct listPullRequests when no snapshot service wired", async () => {
  let listCalled = false;
  const forge = fakeForge({
    listPullRequests: async () => {
      listCalled = true;
      return [PR];
    },
  });
  const app = makeApp(makeDeps(() => forge));
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.prs).toEqual([PR]);
  expect(listCalled).toBe(true);
});

test("GET /api/prs swallows snapshot service error → {slug, prs:[]}", async () => {
  const forge = fakeForge();
  const deps = makeDeps(() => forge);
  deps.openPrSnapshot = {
    get: async () => {
      throw new Error("snapshot fetch failed");
    },
  };
  const app = makeApp(deps);
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: "team/proj", webUrl: null, prs: [] });
});

// End-to-end against a REAL OpenPrSnapshotService (not a get-only stub) so the
// assertion can't pass vacuously: warm the cache, merge, then prove the next
// GET misses the still-TTL-fresh entry and returns the post-merge list.
test("POST /api/prs/merge invalidates the snapshot so the next GET /api/prs drops the merged PR", async () => {
  let merged = false;
  const forge = fakeForge({
    merge: async () => {
      merged = true;
    },
    // Open PR present before merge, gone after — what `gh pr list --state open` would report.
    listOpenPrSnapshot: async () => fakeSnapshot(merged ? [] : [PR]),
  });
  const deps = makeDeps(() => forge);
  deps.openPrSnapshot = new OpenPrSnapshotService(); // real cache + invalidate
  const app = makeApp(deps);

  // 1. Warm the snapshot cache — lists the open PR.
  const before = await (await app.fetch(getReq(repoDir))).json();
  expect(before.prs).toEqual([PR]);

  // 2. Merge it (handler invalidates the snapshot for this repo).
  const mergeRes = await app.fetch(mergeReq({ repo: repoDir, number: PR.number }));
  expect(mergeRes.status).toBe(200);

  // 3. Refetch — without invalidation the entry is still TTL-fresh and would re-list
  //    the merged PR; with it the GET misses and fetches the post-merge (empty) list.
  const after = await (await app.fetch(getReq(repoDir))).json();
  expect(after.prs).toEqual([]);
});
