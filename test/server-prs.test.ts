import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, MergeInput, PullRequest } from "../src/forge/types";
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
  createdAt: 1_700_000_000_000,
  isDraft: false,
  mergeable: true,
  checks: "success",
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
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    openPr: async () => ({ state: "none", checks: "none", deployConfigured: false }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    ...over,
  };
}

function makeDeps(resolveForge: AppDeps["resolveForge"]): AppDeps {
  return {
    store: {} as SessionStore,
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
  expect(await res.json()).toEqual({ slug: null, prs: [] });
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
  expect(await res.json()).toEqual({ slug: "team/proj", prs: [] });
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
