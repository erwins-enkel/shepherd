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
  runId: 1,
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

function postReq(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/actions/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

test("POST /api/actions/rerun re-runs by runId, passing failedOnly", async () => {
  let called: { runId: number; failedOnly: boolean } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        rerunWorkflowRun: async (runId, o) => {
          called = { runId, failedOnly: o.failedOnly };
        },
      }),
    ),
  );
  const res = await app.fetch(postReq("rerun", { repo: repoDir, runId: 7, failedOnly: true }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(called!).toEqual({ runId: 7, failedOnly: true });
});

test("POST /api/actions/rerun defaults failedOnly to false", async () => {
  let failedOnly: boolean | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        rerunWorkflowRun: async (_runId, o) => {
          failedOnly = o.failedOnly;
        },
      }),
    ),
  );
  await app.fetch(postReq("rerun", { repo: repoDir, runId: 7 }));
  expect(failedOnly!).toBe(false);
});

test("POST /api/actions/rerun without a runId → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(postReq("rerun", { repo: repoDir }));
  expect(res.status).toBe(400);
});

test("POST /api/actions/rerun for a forge without the method (gitea) → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ kind: "gitea", rerunWorkflowRun: undefined })));
  const res = await app.fetch(postReq("rerun", { repo: repoDir, runId: 7 }));
  expect(res.status).toBe(400);
});

test("POST /api/actions/rerun surfaces forge failure → 502", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        rerunWorkflowRun: async () => {
          throw new Error("run not found");
        },
      }),
    ),
  );
  const res = await app.fetch(postReq("rerun", { repo: repoDir, runId: 7 }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("run not found");
});

test("POST /api/actions/cancel cancels by runId", async () => {
  let cancelled: number | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        cancelWorkflowRun: async (runId) => {
          cancelled = runId;
        },
      }),
    ),
  );
  const res = await app.fetch(postReq("cancel", { repo: repoDir, runId: 9 }));
  expect(res.status).toBe(200);
  expect(cancelled!).toBe(9);
});

test("POST /api/actions/cancel without a runId → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(postReq("cancel", { repo: repoDir }));
  expect(res.status).toBe(400);
});

test("POST /api/actions/cancel for a forge without the method (gitea) → 400", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ kind: "gitea", cancelWorkflowRun: undefined })));
  const res = await app.fetch(postReq("cancel", { repo: repoDir, runId: 9 }));
  expect(res.status).toBe(400);
});

test("POST /api/actions/cancel surfaces forge failure → 502", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        cancelWorkflowRun: async () => {
          throw new Error("already done");
        },
      }),
    ),
  );
  const res = await app.fetch(postReq("cancel", { repo: repoDir, runId: 9 }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("already done");
});
