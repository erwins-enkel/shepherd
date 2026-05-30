import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";
import type { GitForge, MergeMethod, PrStatus } from "../src/forge/types";

const ORIGIN = "http://localhost";

const SESSION: Session = {
  id: "s1",
  desig: "UNIT-01",
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
  };
  return Object.assign(base, over, { log });
}

function makeDeps(forge: GitForge | null, session: Session | null = SESSION): AppDeps {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : undefined),
  };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => forge,
  };
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
