import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, Issue } from "../src/forge/types";
import type { Session } from "../src/types";

const ISSUE: Issue = {
  number: 42,
  title: "Fix the thing",
  body: "details here",
  url: "https://github.com/team/proj/issues/42",
  labels: [],
  createdAt: 1_700_000_000_000,
};

type Spy = { event: string; data: unknown };

// The route only reads status / issueNumber / repoPath off the original and passes
// the `fresh` session through verbatim — so the mocks cast minimal shapes through
// `unknown` rather than filling the whole Session type.
function harness(opts: {
  original?: Partial<Session> | null; // null → store.get returns undefined (404)
  fresh?: Session; // what service.relaunch resolves to
  relaunchThrows?: Error;
  resolveForge?: AppDeps["resolveForge"];
  archiveCleared?: string[]; // ids archiveMany reports cleared (default: the requested id)
}) {
  const emitted: Spy[] = [];
  const calls = { relaunch: [] as Array<{ id: string; issueRef: unknown }> };
  let retainClaimSeenArchived = false;

  const originalSession =
    opts.original === null
      ? undefined
      : ({
          id: "orig",
          repoPath: "/repo",
          status: "running",
          issueNumber: null,
          ...opts.original,
        } as unknown as Session);

  const fresh =
    opts.fresh ?? ({ id: "new", desig: "TASK-02", repoPath: "/repo" } as unknown as Session);

  const store = {
    get: (id: string) => (id === "orig" ? originalSession : undefined),
  } as unknown as SessionStore;

  const service = {
    relaunch: async (id: string, issueRef: unknown) => {
      calls.relaunch.push({ id, issueRef });
      if (opts.relaunchThrows) throw opts.relaunchThrows;
      return fresh;
    },
    archiveMany: (ids: string[]) => ({
      cleared: opts.archiveCleared ?? ids,
      leftovers: 0,
    }),
  } as unknown as SessionService;

  const events = {
    emit: (event: string, data: unknown) => {
      emitted.push({ event, data });
    },
  } as unknown as EventHub;

  const drainCalls: string[] = [];
  const droppedFromCache: string[] = [];

  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: opts.resolveForge,
    prCache: {
      drop: (id: string) => droppedFromCache.push(id),
    } as unknown as AppDeps["prCache"],
    drain: {
      snapshot: async () => [],
      queue: async () => [],
      retainClaim: (id: string) => {
        drainCalls.push(id);
        // record whether session:archived was already emitted at retain time
        retainClaimSeenArchived = emitted.some((e) => e.event === "session:archived");
      },
    },
  };

  return {
    app: makeApp(deps),
    emitted,
    calls,
    drainCalls,
    droppedFromCache,
    retainSeenArchived: () => retainClaimSeenArchived,
  };
}

function relaunchReq(id = "orig"): Request {
  return new Request(`http://localhost/api/sessions/${id}/relaunch`, { method: "POST" });
}

function fakeForge(over: Partial<GitForge> = {}): GitForge {
  return {
    kind: "github",
    slug: "team/proj",
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
    getIssue: async () => ISSUE,
    ...over,
  };
}

test("happy path: emits session:new then session:archived, returns {session, archived:true}", async () => {
  const h = harness({ original: { issueNumber: null } });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.archived).toBe(true);
  expect(body.session.id).toBe("new");

  const order = h.emitted.map((e) => e.event);
  expect(order).toEqual(["session:new", "session:archived"]);
  expect(h.emitted[0]?.data).toMatchObject({ id: "new" });
  expect(h.emitted[1]?.data).toEqual({ id: "orig" });
  expect(h.calls.relaunch).toHaveLength(1);
  expect(h.calls.relaunch[0]).toEqual({ id: "orig", issueRef: undefined });
  expect(h.droppedFromCache).toEqual(["orig"]);
});

test("retainClaim is called before the session:archived emit", async () => {
  const h = harness({ original: { issueNumber: null } });
  await h.app.fetch(relaunchReq());
  expect(h.drainCalls).toEqual(["orig"]);
  expect(h.retainSeenArchived()).toBe(false); // archived not yet emitted when retain fired
});

test("missing original → 404, nothing spawned", async () => {
  const h = harness({ original: null });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(404);
  expect(h.calls.relaunch).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("archived original → 409, nothing spawned", async () => {
  const h = harness({ original: { status: "archived" } });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(409);
  expect(h.calls.relaunch).toHaveLength(0);
});

test("issue-linked original re-resolves and threads issueRef into service.relaunch", async () => {
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () => fakeForge(),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  expect(h.calls.relaunch[0]?.issueRef).toEqual({
    number: 42,
    url: ISSUE.url,
    title: ISSUE.title,
    body: ISSUE.body,
  });
});

test("issue-linked original whose getIssue returns null → 502, nothing spawned or torn down", async () => {
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () => fakeForge({ getIssue: async () => null }),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(502);
  expect((await res.json()).error).toMatch(/re-resolve/);
  expect(h.calls.relaunch).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
  expect(h.drainCalls).toHaveLength(0);
});

test("issue-linked original whose getIssue throws → 502, nothing spawned", async () => {
  const h = harness({
    original: { issueNumber: 42 },
    resolveForge: () =>
      fakeForge({
        getIssue: async () => {
          throw new Error("network down");
        },
      }),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(502);
  expect(h.calls.relaunch).toHaveLength(0);
  expect(h.emitted).toHaveLength(0);
});

test("spawn failure (service.relaunch throws) → 502, original left intact (no archive/emit)", async () => {
  const h = harness({
    original: { issueNumber: null },
    relaunchThrows: new Error("herdr boom"),
  });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("herdr boom");
  expect(h.emitted).toHaveLength(0); // no session:new, no session:archived
  expect(h.drainCalls).toHaveLength(0); // retainClaim never reached
});

test("teardown not-cleared → archived:false, still emits session:new (no session:archived)", async () => {
  const h = harness({ original: { issueNumber: null }, archiveCleared: [] });
  const res = await h.app.fetch(relaunchReq());
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.archived).toBe(false);
  expect(body.session.id).toBe("new");
  const order = h.emitted.map((e) => e.event);
  expect(order).toEqual(["session:new"]); // archived NOT emitted
  expect(h.droppedFromCache).toHaveLength(0); // prCache.drop only on cleared
  // No session:archived fires, so drain.onArchived never runs to consume a retain flag.
  // Stamping retainClaim here would leak a stale one-shot that mis-converts a later
  // manual abandon of the still-live original into a retire — so it MUST NOT be called.
  expect(h.drainCalls).toHaveLength(0);
});

test("concurrent second relaunch of the same id → 409, no double-spawn", async () => {
  // Make service.relaunch hang until released so two requests overlap.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let relaunchCalls = 0;
  const emitted: Spy[] = [];

  const deps: AppDeps = {
    store: {
      get: () => ({ id: "orig", repoPath: "/repo", status: "running", issueNumber: null }),
    } as unknown as SessionStore,
    service: {
      relaunch: async () => {
        relaunchCalls++;
        await gate;
        return { id: "new", desig: "TASK-02" } as unknown as Session;
      },
      archiveMany: (ids: string[]) => ({ cleared: ids, leftovers: 0 }),
    } as unknown as SessionService,
    events: {
      emit: (event: string, data: unknown) => emitted.push({ event, data }),
    } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    drain: { snapshot: async () => [], queue: async () => [], retainClaim: () => {} },
    prCache: { drop: () => {} } as unknown as AppDeps["prCache"],
  };
  const app = makeApp(deps);

  const first = app.fetch(relaunchReq()); // starts, hangs in relaunch
  // give the first request a tick to register in inFlightRelaunch
  await new Promise((r) => setTimeout(r, 10));
  const secondRes = await app.fetch(relaunchReq());
  expect(secondRes.status).toBe(409);
  expect((await secondRes.json()).error).toMatch(/in progress/);
  expect(relaunchCalls).toBe(1); // second request did NOT spawn

  release();
  const firstRes = await first;
  expect(firstRes.status).toBe(201);

  // after the first completes, the id is cleared → a fresh relaunch is allowed again
  const thirdRes = await app.fetch(relaunchReq());
  expect(thirdRes.status).toBe(201);
  expect(relaunchCalls).toBe(2);
});
