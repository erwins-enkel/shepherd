import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, WorkflowRun } from "../src/forge/types";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-actions-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN: WorkflowRun = {
  workflowName: "CI",
  runUrl: "https://github.com/team/proj/actions/runs/1",
  headSha: "sha1",
  createdAt: 1_700_000_000_000,
  state: "failure",
  jobs: [
    { name: "lint", state: "success", url: "https://gh/job/a" },
    { name: "test", state: "failure", url: "https://gh/job/b" },
  ],
};

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "github",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listWorkflowRuns: async () => [RUN],
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
  return new Request(`http://localhost/api/actions?repo=${encodeURIComponent(repo)}`);
}

test("GET /api/actions resolves via the forge → {slug, kind, runs}", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: "team/proj", kind: "github", runs: [RUN] });
});

test("GET /api/actions with no forge → empty, null slug/kind", async () => {
  const app = makeApp(makeDeps(() => null));
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({ slug: null, kind: null, runs: [] });
});

test("GET /api/actions for a forge without listWorkflowRuns (e.g. gitea) → empty", async () => {
  const app = makeApp(
    makeDeps(() => fakeForge({ kind: "gitea", slug: "team/proj", listWorkflowRuns: undefined })),
  );
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({ slug: "team/proj", kind: "gitea", runs: [] });
});

test("GET /api/actions swallows forge errors → empty runs", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRuns: async () => {
          throw new Error("gh not authed");
        },
      }),
    ),
  );
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({ slug: "team/proj", kind: "github", runs: [] });
});

test("GET /api/actions?repo outside root → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(getReq("/etc"));
  expect(res.status).toBe(400);
});
