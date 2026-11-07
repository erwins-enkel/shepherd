import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, WorkflowRun } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import { config } from "../src/config";
import { CiRestartHolds } from "../src/ci-restart-hold";

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
  workflowId: 5,
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
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    listWorkflowRuns: async () => [RUN],
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

test("GET /api/actions resolves via the forge → {slug, kind, runs, capability flags}", async () => {
  // fakeForge() has listWorkflowRuns but no rerun/cancel → supportsActions only.
  const app = makeApp(makeDeps(() => fakeForge()));
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    slug: "team/proj",
    webUrl: null,
    kind: "github",
    runs: [RUN],
    supportsActions: true,
    canRerun: false,
    canCancel: false,
  });
});

test("GET /api/actions: full GitHub forge (rerun+cancel) → all caps true", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        rerunWorkflowRun: async () => {},
        cancelWorkflowRun: async () => {},
      }),
    ),
  );
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({
    slug: "team/proj",
    webUrl: null,
    kind: "github",
    runs: [RUN],
    supportsActions: true,
    canRerun: true,
    canCancel: true,
  });
});

test("GET /api/actions with no forge → empty, null slug/kind, all caps false", async () => {
  const app = makeApp(makeDeps(() => null));
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({
    slug: null,
    webUrl: null,
    kind: null,
    runs: [],
    supportsActions: false,
    canRerun: false,
    canCancel: false,
  });
});

test("GET /api/actions for a forge without listWorkflowRuns (e.g. gitea) → empty, supportsActions false", async () => {
  const app = makeApp(
    makeDeps(() => fakeForge({ kind: "gitea", slug: "team/proj", listWorkflowRuns: undefined })),
  );
  const res = await app.fetch(getReq(repoDir));
  expect(await res.json()).toEqual({
    slug: "team/proj",
    webUrl: null,
    kind: "gitea",
    runs: [],
    supportsActions: false,
    canRerun: false,
    canCancel: false,
  });
});

test("GET /api/actions swallows forge errors → empty runs, caps still reflect the forge", async () => {
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
  expect(await res.json()).toEqual({
    slug: "team/proj",
    webUrl: null,
    kind: "github",
    runs: [],
    supportsActions: true,
    canRerun: false,
    canCancel: false,
  });
});

test("GET /api/actions includes forge webUrl in response", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ webUrl: "https://github.com/team/proj" })));
  const res = await app.fetch(getReq(repoDir));
  expect(res.status).toBe(200);
  expect((await res.json()).webUrl).toBe("https://github.com/team/proj");
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

test("POST /api/actions/retry-ci resolves the PR's failed run then reruns failedOnly", async () => {
  let resolvedPr: number | null = null;
  let rerun: { runId: number; failedOnly: boolean } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        latestFailedRunForPr: async (pr) => {
          resolvedPr = pr;
          return 123;
        },
        rerunWorkflowRun: async (runId, o) => {
          rerun = { runId, failedOnly: o.failedOnly };
        },
      }),
    ),
  );
  const res = await app.fetch(postReq("retry-ci", { repo: repoDir, pr: 42 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(resolvedPr!).toBe(42);
  expect(rerun!).toEqual({ runId: 123, failedOnly: true });
});

test("POST /api/actions/retry-ci without a pr → 400", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({ latestFailedRunForPr: async () => 1, rerunWorkflowRun: async () => {} }),
    ),
  );
  const res = await app.fetch(postReq("retry-ci", { repo: repoDir }));
  expect(res.status).toBe(400);
});

test("POST /api/actions/retry-ci for a forge without rerun (gitea) → 200 { ok:false, reason:'unsupported' }", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({ kind: "gitea", rerunWorkflowRun: undefined, latestFailedRunForPr: undefined }),
    ),
  );
  const res = await app.fetch(postReq("retry-ci", { repo: repoDir, pr: 42 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false, reason: "unsupported" });
});

test("POST /api/actions/retry-ci when no failed run resolves → 200 { ok:false, reason:'no-run' }", async () => {
  let rerunCalled = false;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        latestFailedRunForPr: async () => null,
        rerunWorkflowRun: async () => {
          rerunCalled = true;
        },
      }),
    ),
  );
  const res = await app.fetch(postReq("retry-ci", { repo: repoDir, pr: 42 }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: false, reason: "no-run" });
  expect(rerunCalled).toBe(false);
});

test("POST /api/actions/retry-ci surfaces forge failure → 502", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        latestFailedRunForPr: async () => {
          throw new Error("gh boom");
        },
        rerunWorkflowRun: async () => {},
      }),
    ),
  );
  const res = await app.fetch(postReq("retry-ci", { repo: repoDir, pr: 42 }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("gh boom");
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

function historyReq(repo: string, workflowId: number, limit = 10): Request {
  return new Request(
    `http://localhost/api/actions/history?repo=${encodeURIComponent(repo)}&workflowId=${workflowId}&limit=${limit}`,
  );
}
function jobsReq(repo: string, runId: number): Request {
  return new Request(
    `http://localhost/api/actions/run-jobs?repo=${encodeURIComponent(repo)}&runId=${runId}`,
  );
}

test("GET /api/actions/history returns the workflow's prior runs", async () => {
  let got: { workflowId: number; limit: number } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRunHistory: async (workflowId, o) => {
          got = { workflowId, limit: o.limit };
          return [RUN];
        },
      }),
    ),
  );
  const res = await app.fetch(historyReq(repoDir, 5, 25));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ runs: [RUN] });
  expect(got!).toEqual({ workflowId: 5, limit: 25 });
});

test("GET /api/actions/history clamps limit to 50 and requires a workflowId", async () => {
  let seenLimit = 0;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRunHistory: async (_w, o) => {
          seenLimit = o.limit;
          return [];
        },
      }),
    ),
  );
  await app.fetch(historyReq(repoDir, 5, 999));
  expect(seenLimit).toBe(50);
  const bad = await app.fetch(
    new Request(`http://localhost/api/actions/history?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(bad.status).toBe(400);
});

test("GET /api/actions/history for a forge without the method → empty", async () => {
  const app = makeApp(
    makeDeps(() => fakeForge({ kind: "gitea", listWorkflowRunHistory: undefined })),
  );
  const res = await app.fetch(historyReq(repoDir, 5));
  expect(await res.json()).toEqual({ runs: [] });
});

test("GET /api/actions/history swallows forge errors → empty", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRunHistory: async () => {
          throw new Error("gh boom");
        },
      }),
    ),
  );
  expect(await (await app.fetch(historyReq(repoDir, 5))).json()).toEqual({ runs: [] });
});

test("GET /api/actions/run-jobs returns a run's jobs", async () => {
  let gotRunId = 0;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listRunJobs: async (runId) => {
          gotRunId = runId;
          return RUN.jobs;
        },
      }),
    ),
  );
  const res = await app.fetch(jobsReq(repoDir, 42));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jobs: RUN.jobs });
  expect(gotRunId).toBe(42);
});

test("GET /api/actions/run-jobs requires a runId; missing method → empty", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ listRunJobs: undefined })));
  expect(await (await app.fetch(jobsReq(repoDir, 42))).json()).toEqual({ jobs: [] });
  const bad = await app.fetch(
    new Request(`http://localhost/api/actions/run-jobs?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(bad.status).toBe(400);
});

// ── POST /api/sessions/:id/ci/restart (#2863) ─────────────────────────────────────────────────

describe("POST /api/sessions/:id/ci/restart", () => {
  const JOB_URL = "https://github.com/team/proj/actions/runs/42/job/7";
  const session = { id: "s1", status: "running", repoPath: "/repo" };
  const openGit = (state: "pending" | "failure" = "pending", url = JOB_URL) => ({
    kind: "github",
    state: "open",
    checks: state,
    deployConfigured: false,
    jobs: [{ name: "CI / gate", state, url }],
  });
  const restartForge = () =>
    fakeForge({
      cancelWorkflowRun: async () => {},
      rerunWorkflowRun: async () => {},
      getRunDetail: async () => null,
    });

  function setup(
    o: { git?: unknown; forge?: GitForge | null; withRestart?: boolean; held?: boolean } = {},
  ) {
    const holds = new CiRestartHolds({ set: () => 0, clear: () => {} });
    if (o.held) holds.hold("s1", { name: "CI / gate" });
    const runs: { id: string; runId: number }[] = [];
    const emitted: { event: string; data: unknown }[] = [];
    let onFailed: ((reason: "cancel" | "rerun") => void) | undefined;
    const deps: AppDeps = {
      ...makeDeps(() => (o.forge === undefined ? restartForge() : o.forge)),
      events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as never,
      store: { get: (id: string) => (id === "s1" ? session : null) } as unknown as SessionStore,
      prCache: { get: () => (o.git === undefined ? openGit() : o.git) } as never,
      ...(o.withRestart === false
        ? {}
        : {
            ciRestart: {
              holds,
              refreshPr: () => {},
              run: async (a: {
                id: string;
                runId: number;
                onFailed: (reason: "cancel" | "rerun") => void;
              }) => {
                runs.push({ id: a.id, runId: a.runId });
                onFailed = a.onFailed;
              },
            },
          }),
    };
    const app = makeApp(deps);
    const post = (id: string, body: unknown) =>
      app.fetch(
        new Request(`http://localhost/api/sessions/${id}/ci/restart`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    return { post, holds, runs, emitted, fail: (r: "cancel" | "rerun") => onFailed?.(r) };
  }

  test("holds red-CI steers and starts the restart with the run id from the CACHED job url", async () => {
    const t = setup();
    const res = await t.post("s1", { job: "CI / gate" });
    expect(res.status).toBe(202);
    expect(t.holds.phase("s1")).toBe("cancelling");
    expect(t.runs).toEqual([{ id: "s1", runId: 42 }]);
    t.fail("rerun"); // a background failure reaches the operator as an event
    expect(t.emitted).toContainEqual({
      event: "session:ci-restart-failed",
      data: { id: "s1", reason: "rerun" },
    });
  });

  test("validates the request and the session's PR state", async () => {
    expect((await setup().post("s1", {})).status).toBe(400);
    expect((await setup().post("nope", { job: "CI / gate" })).status).toBe(404);
    expect((await setup({ withRestart: false }).post("s1", { job: "CI / gate" })).status).toBe(503);
    expect((await setup({ git: { state: "none" } }).post("s1", { job: "CI / gate" })).status).toBe(
      409,
    );
    expect((await setup().post("s1", { job: "CI / other" })).status).toBe(409);
    expect((await setup({ git: openGit("failure") }).post("s1", { job: "CI / gate" })).status).toBe(
      409,
    );
    expect((await setup({ held: true }).post("s1", { job: "CI / gate" })).status).toBe(409);
  });

  test("400 when the forge can't restart or the job url names no run; nothing held", async () => {
    for (const t of [
      setup({ forge: fakeForge() }),
      setup({ forge: null }),
      setup({ git: openGit("pending", "https://ci.example/jobs/9") }),
    ]) {
      expect((await t.post("s1", { job: "CI / gate" })).status).toBe(400);
      expect(t.holds.held("s1")).toBe(false);
      expect(t.runs).toEqual([]);
    }
  });
});
