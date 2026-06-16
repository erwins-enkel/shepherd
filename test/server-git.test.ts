import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";
import type { GitForge, GitState, MergeMethod, PrStatus } from "../src/forge/types";
import type { PrCache } from "../src/pr-poller";

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
  status: "running",
  lastState: "working",
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
};

function fakeForge(
  over: Partial<GitForge> = {},
  extras: { mergeMethod?: MergeMethod; deployWorkflow?: string | null } = {},
): GitForge & { log: string[] } {
  const log: string[] = [];
  const base: GitForge = {
    kind: "gitea",
    slug: "team/proj",
    mergeMethod: extras.mergeMethod ?? "squash",
    deployWorkflow: extras.deployWorkflow === undefined ? "deploy.yaml" : extras.deployWorkflow,
    listIssues: async () => [],
    listPullRequests: async () => [],
    prStatus: async (head) => {
      log.push(`status:${head}`);
      return { state: "open", number: 5, checks: "success", deployConfigured: true } as PrStatus;
    },
    openPr: async (o) => {
      log.push(`openPr:${o.head}->${o.base}:${o.title}`);
      return { state: "open", number: 5, checks: "pending", deployConfigured: true };
    },
    merge: async (n, o) => {
      log.push(`merge:${n}:${o.method}:${o.deleteBranch}`);
    },
    redeploy: async (o) => {
      log.push(`redeploy:${o.workflow}:${o.ref}`);
    },
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return Object.assign(base, over, { log });
}

function makeDeps(
  forge: GitForge | null,
  session: Session | null = SESSION,
  opts: { draftMode?: boolean } = {},
): AppDeps & { emitted: { event: string; data: unknown }[]; cacheWrites: string[] } {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
    getRepoConfig: () => ({ draftMode: opts.draftMode ?? false }) as any,
  };
  const emitted: { event: string; data: unknown }[] = [];
  const cacheWrites: string[] = [];
  const snap: Record<string, GitState> = {};
  const prCache: PrCache = {
    snapshot: () => snap,
    get: (id: string) => snap[id],
    set: (id: string) => cacheWrites.push(id),
    drop: (id: string) => cacheWrites.push(`drop:${id}`),
  };
  return Object.assign(
    {
      store: store as SessionStore,
      service: {} as SessionService,
      events: {
        emit: (event: string, data: unknown) => emitted.push({ event, data }),
      } as unknown as EventHub,
      usageLimits: { limits: () => ({}) } as never,
      resolveForge: () => forge,
      prCache,
    },
    { emitted, cacheWrites },
  );
}

function post(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GET /api/sessions/:id/git → kind + PrStatus", async () => {
  const f = fakeForge();
  const app = makeApp(makeDeps(f));
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.kind).toBe("gitea");
  expect(body.state).toBe("open");
  expect(body.number).toBe(5);
  expect(f.log).toContain("status:shepherd/add-feature");
});

test("GET git drops a merged PR whose head isn't on the session's branch (name collision)", async () => {
  const f = fakeForge({
    prStatus: async () => ({
      state: "merged",
      number: 344,
      checks: "success",
      headSha: "deadbee",
      deployConfigured: true,
    }),
  });
  // ownsPr says the merged head doesn't belong to this branch → guard to none, so
  // GitRail matches the (guarded) list overview instead of flashing a false MERGED.
  const deps = Object.assign(makeDeps(f), { ownsPr: () => false });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.state).toBe("none");
  expect(body.number).toBeUndefined();
});

test("GET git keeps a merged PR owned by the session's branch", async () => {
  const f = fakeForge({
    prStatus: async () => ({
      state: "merged",
      number: 5,
      checks: "success",
      headSha: "deadbee",
      deployConfigured: true,
    }),
  });
  const deps = Object.assign(makeDeps(f), { ownsPr: () => true });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  const body = await res.json();
  expect(body.state).toBe("merged");
  expect(body.number).toBe(5);
});

test("GET git → 404 when no forge for repo", async () => {
  const app = makeApp(makeDeps(null));
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect(res.status).toBe(404);
});

test("GET git → 404 when session unknown", async () => {
  const app = makeApp(makeDeps(fakeForge(), null));
  const res = await app.fetch(new Request("http://localhost/api/sessions/nope/git"));
  expect(res.status).toBe(404);
});

test("POST git/pr defaults title to session name + body to prompt", async () => {
  const f = fakeForge();
  const app = makeApp(makeDeps(f));
  const res = await app.fetch(post("/api/sessions/s1/git/pr", {}));
  expect(res.status).toBe(200);
  expect(f.log[0]).toBe("openPr:shepherd/add-feature->main:Add feature");
});

test("POST git/pr honors explicit title", async () => {
  const f = fakeForge();
  const app = makeApp(makeDeps(f));
  await app.fetch(post("/api/sessions/s1/git/pr", { title: "Custom", body: "B" }));
  expect(f.log[0]).toBe("openPr:shepherd/add-feature->main:Custom");
});

test("POST git/merge uses forge-default method + deletes branch, returns refreshed status", async () => {
  const f = fakeForge();
  const app = makeApp(makeDeps(f));
  const res = await app.fetch(post("/api/sessions/s1/git/merge", {}));
  expect(res.status).toBe(200);
  expect(f.log).toContain("merge:5:squash:true");
  expect(f.log[f.log.length - 1]).toBe("status:shepherd/add-feature"); // refreshed after merge
});

test("POST git/merge honors explicit method override", async () => {
  const f = fakeForge();
  const app = makeApp(makeDeps(f));
  await app.fetch(post("/api/sessions/s1/git/merge", { method: "rebase" }));
  expect(f.log).toContain("merge:5:rebase:true");
});

test("POST git/merge → 409 when no open PR", async () => {
  const f = fakeForge({
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: true }),
  });
  const app = makeApp(makeDeps(f));
  const res = await app.fetch(post("/api/sessions/s1/git/merge", {}));
  expect(res.status).toBe(409);
});

test("POST git/redeploy dispatches configured workflow against base branch", async () => {
  const f = fakeForge();
  const app = makeApp(makeDeps(f));
  const res = await app.fetch(post("/api/sessions/s1/git/redeploy"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(f.log).toContain("redeploy:deploy.yaml:main");
});

test("POST git/redeploy → 400 when no deployWorkflow configured", async () => {
  const f = fakeForge({}, { deployWorkflow: null });
  const app = makeApp(makeDeps(f));
  const res = await app.fetch(post("/api/sessions/s1/git/redeploy"));
  expect(res.status).toBe(400);
});

test("GET /api/git returns the prCache snapshot", async () => {
  const deps = makeDeps(fakeForge());
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/git"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("GET git trusts a merged PR when cache already showed it open (signal b)", async () => {
  const f = fakeForge({
    prStatus: async () => ({
      state: "merged",
      number: 5,
      headSha: "newsha",
      checks: "success",
      deployConfigured: true,
    }),
  });
  const deps = Object.assign(makeDeps(f), { ownsPr: () => false });
  const baseCache = deps.prCache!;
  // Seed the prior cached state as an OPEN PR #5; the GET handler reads it via get().
  const seeded: GitState = {
    kind: "gitea",
    state: "open",
    number: 5,
    checks: "success",
    deployConfigured: true,
  };
  deps.prCache = {
    snapshot: () => ({ s1: seeded }),
    get: (id) => (id === "s1" ? seeded : undefined),
    set: baseCache.set,
    drop: baseCache.drop,
  };
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.state).toBe("merged");
  expect(body.number).toBe(5);
});

test("GET git trusts a merged PR when session is merge-train-flagged, cold cache (signal a)", async () => {
  const f = fakeForge({
    prStatus: async () => ({
      state: "merged",
      number: 344,
      headSha: "somesha",
      checks: "success",
      deployConfigured: true,
    }),
  });
  const mergeTrainSession = {
    ...SESSION,
    mergingSince: Date.now(),
    mergingTrainId: "t",
    mergingPrNumber: 344,
  };
  const deps = Object.assign(makeDeps(f, mergeTrainSession), { ownsPr: () => false });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.state).toBe("merged");
  expect(body.number).toBe(344);
});

test("GET /api/activity returns the activity snapshot", async () => {
  const snap = { s1: { lastActivityTs: 123, summary: "edited poller.ts" } };
  const deps = Object.assign(makeDeps(fakeForge()), { activity: { snapshot: () => snap } });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/activity"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(snap);
});

test("GET /api/activity → {} when no activity dep is wired", async () => {
  const app = makeApp(makeDeps(fakeForge()));
  const res = await app.fetch(new Request("http://localhost/api/activity"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("GET /api/subagents returns the sub-agent roster snapshot", async () => {
  const snap = {
    s1: [{ agentId: "a1", agentType: "general-purpose", startedAt: 123 }],
  };
  const deps = Object.assign(makeDeps(fakeForge()), {
    hooks: {
      record: () => {},
      snapshot: () => [],
      allSubagentsSnapshot: () => snap,
    } as AppDeps["hooks"],
  });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/subagents"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(snap);
});

test("GET /api/subagents → {} when no hooks dep is wired", async () => {
  const app = makeApp(makeDeps(fakeForge()));
  const res = await app.fetch(new Request("http://localhost/api/subagents"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("POST git/pr writes cache + emits session:git", async () => {
  const deps = makeDeps(fakeForge());
  const app = makeApp(deps);
  await app.fetch(post("/api/sessions/s1/git/pr", {}));
  expect(deps.cacheWrites).toContain("s1");
  const ev = deps.emitted.find((e) => e.event === "session:git");
  expect(ev?.data).toMatchObject({ id: "s1", git: { kind: "gitea", state: "open" } });
});

test("POST git/merge writes cache + emits session:git", async () => {
  const deps = makeDeps(fakeForge());
  const app = makeApp(deps);
  await app.fetch(post("/api/sessions/s1/git/merge", {}));
  const ev = deps.emitted.find((e) => e.event === "session:git");
  expect(ev?.data).toMatchObject({ id: "s1", git: { kind: "gitea" } });
});

// ── draft mode ───────────────────────────────────────────────────────────────

test("POST git/pr passes draft=true to forge.openPr when repo draftMode=true", async () => {
  const calls: any[] = [];
  const f = fakeForge({
    openPr: async (o) => {
      calls.push(o);
      return { state: "open", number: 5, checks: "pending", deployConfigured: true };
    },
  });
  const app = makeApp(makeDeps(f, SESSION, { draftMode: true }));
  await app.fetch(post("/api/sessions/s1/git/pr", {}));
  expect(calls[0]?.draft).toBe(true);
});

test("POST git/pr passes draft=false to forge.openPr when repo draftMode=false", async () => {
  const calls: any[] = [];
  const f = fakeForge({
    openPr: async (o) => {
      calls.push(o);
      return { state: "open", number: 5, checks: "pending", deployConfigured: true };
    },
  });
  const app = makeApp(makeDeps(f, SESSION, { draftMode: false }));
  await app.fetch(post("/api/sessions/s1/git/pr", {}));
  expect(calls[0]?.draft).toBe(false);
});
