import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { PrCache } from "../src/pr-poller";
import type { ReviewOutcome } from "../src/review";

const ORIGIN = "http://localhost";

const SESSION: Session = {
  id: "s1",
  desig: "TASK-01",
  name: "Add feature",
  prompt: "Add the feature",
  repoPath: "/repo",
  baseBranch: "main",
  branch: "shepherd/add-feature",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "a1",
  claudeSessionId: "c1",
  model: null,
  effort: null,
  readyToMerge: false,
  mergingSince: null,
  mergingTrainId: null,
  mergeTrainPrs: null,
  mergingPrNumber: null,
  autopilotEnabled: null,
  autopilotStepCount: 0,
  autopilotPaused: false,
  autopilotComplete: false,
  autopilotQuestion: null,
  completionRepromptCount: 0,
  planGateEnabled: null,
  planPhase: null,
  autoMergeEnabled: null,
  autoMergeRebaseCount: 0,
  autoMergeRebaseHead: null,
  auto: false,
  issueNumber: null,
  sandboxApplied: null,
  sandboxDegraded: false,
  egressApplied: false,
  egressDegraded: false,
  research: false,
  epicAuthoring: false,
  status: "running",
  lastState: "working",
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
  haltReason: null,
  haltedAt: null,
  manualSteps: [],
  manualStepsAckedAt: null,
  experimentId: null,
  experimentRole: null,
  spawnTerminalId: null,
  spawnAccountDir: null,
};

function fakeForge(over: Partial<GitForge> = {}): GitForge & { log: string[] } {
  const log: string[] = [];
  const base: GitForge = {
    kind: "gitea",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: "deploy.yaml",
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (head) => {
      log.push(`status:${head}`);
      return { state: "open", number: 5, checks: "success", deployConfigured: true } as PrStatus;
    },
    openPr: async () => ({ state: "open", number: 5, checks: "pending", deployConfigured: true }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return Object.assign(base, over, { log });
}

function makeDeps(
  forge: GitForge | null,
  session: Session | null = SESSION,
  reviewTrigger?: AppDeps["reviewTrigger"],
): AppDeps {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
    getRepoConfig: () => ({}) as any,
  };
  const snap: Record<string, GitState> = {};
  const prCache: PrCache = {
    snapshot: () => snap,
    get: (id: string) => snap[id],
    set: () => {},
    drop: () => {},
  };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => forge,
    prCache,
    reviewTrigger,
  };
}

function post(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
  });
}

test("POST review-pr → 404 for unknown id (force not called)", async () => {
  let called = false;
  const app = makeApp(
    makeDeps(fakeForge(), SESSION, {
      force: async () => {
        called = true;
        return "started";
      },
    }),
  );
  const res = await app.fetch(post("/api/sessions/nope/review-pr"));
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});

test("POST review-pr → 404 when no forge for repo", async () => {
  const app = makeApp(makeDeps(null));
  const res = await app.fetch(post("/api/sessions/s1/review-pr"));
  expect(res.status).toBe(404);
});

test("POST review-pr → 202 relays status:started, calls force once with session + resolved GitState", async () => {
  const calls: { session: Session; git: GitState }[] = [];
  const app = makeApp(
    makeDeps(fakeForge(), SESSION, {
      force: async (session, git) => {
        calls.push({ session, git });
        return "started";
      },
    }),
  );
  const res = await app.fetch(post("/api/sessions/s1/review-pr"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "started" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.session.id).toBe("s1");
  // resolved GitState carries the live forge prStatus + kind
  expect(calls[0]!.git.kind).toBe("gitea");
  expect(calls[0]!.git.state).toBe("open");
  expect(calls[0]!.git.number).toBe(5);
});

test("POST review-pr → 202 relays status:skipped", async () => {
  const app = makeApp(
    makeDeps(fakeForge(), SESSION, {
      force: async () => "skipped" as ReviewOutcome,
    }),
  );
  const res = await app.fetch(post("/api/sessions/s1/review-pr"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "skipped" });
});

test("POST review-pr → 202 status:skipped when reviewTrigger absent", async () => {
  const app = makeApp(makeDeps(fakeForge()));
  const res = await app.fetch(post("/api/sessions/s1/review-pr"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "skipped" });
});

test("POST review-pr → 502 when forge prStatus throws", async () => {
  const f = fakeForge({
    prStatus: async () => {
      throw new Error("forge boom");
    },
  });
  const app = makeApp(
    makeDeps(f, SESSION, {
      force: async () => "started",
    }),
  );
  const res = await app.fetch(post("/api/sessions/s1/review-pr"));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("forge boom");
});

test("GET /api/sessions/:id/review-pr falls through (handler claims POST only)", async () => {
  let called = false;
  const app = makeApp(
    makeDeps(fakeForge(), SESSION, {
      force: async () => {
        called = true;
        return "started";
      },
    }),
  );
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/review-pr"));
  // not a registered GET route → 404 (handler returned null, no other claims it)
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});
