import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";
import type { GitForge, GitState, MergeMethod, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
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
  landingRepair: false,
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
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
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
  opts: {
    draftMode?: boolean;
    signoffAuthority?: "human" | "critic" | "either";
    /** Injected worktree-branch reconcile: `resolveGitState` calls it on a "none" result
     *  to adopt a renamed branch and retry. Absent (default) → reconcile is a no-op. */
    syncBranch?: (id: string) => string | null;
  } = {},
): AppDeps & {
  emitted: { event: string; data: unknown }[];
  cacheWrites: string[];
  /** The live cache map, exposed so a test can pre-seed a prior state (e.g. an already
   *  cached open PR) and assert observable mutation after a GET write-through. */
  snap: Record<string, GitState>;
} {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
    getRepoConfig: () =>
      ({
        draftMode: opts.draftMode ?? false,
        signoffAuthority: opts.signoffAuthority ?? "human",
      }) as any,
    getReview: () => null,
  };
  const emitted: { event: string; data: unknown }[] = [];
  const cacheWrites: string[] = [];
  const snap: Record<string, GitState> = {};
  // Observable store (not just a write-log): `set` mutates `snap` so a later `get`
  // reflects it — lets a second GET see the first's write-through and stay silent.
  const prCache: PrCache = {
    snapshot: () => snap,
    get: (id: string) => snap[id],
    set: (id: string, git: GitState) => {
      snap[id] = git;
      cacheWrites.push(id);
    },
    drop: (id: string) => {
      delete snap[id];
      cacheWrites.push(`drop:${id}`);
    },
  };
  return Object.assign(
    {
      store: store as SessionStore,
      service: { syncWorktreeBranch: opts.syncBranch } as unknown as SessionService,
      events: {
        emit: (event: string, data: unknown) => emitted.push({ event, data }),
      } as unknown as EventHub,
      usageLimits: { limits: () => ({}) } as never,
      resolveForge: () => forge,
      prCache,
    },
    { emitted, cacheWrites, snap },
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
  // The guarded-to-none collision is a no-PR result for an uncached session → no write-through.
  expect(deps.cacheWrites).toEqual([]);
  expect(deps.emitted.filter((e) => e.event === "session:git")).toHaveLength(0);
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

// ── GET write-through: the live git-rail fetch feeds the card's cache (issue: card shows
//    no PR while the detail view does). resolveGitState now caches + emits session:git on a
//    meaningful change, and reconciles a renamed branch first. ───────────────────────────
const gitEvents = (deps: { emitted: { event: string; data: unknown }[] }) =>
  deps.emitted.filter((e) => e.event === "session:git");

test("GET git write-through surfaces an open PR into the cache and emits session:git", async () => {
  const deps = makeDeps(fakeForge()); // default prStatus → open #5
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect((await res.json()).state).toBe("open");
  expect(deps.cacheWrites).toEqual(["s1"]);
  expect(deps.snap.s1?.state).toBe("open");
  expect(gitEvents(deps)).toHaveLength(1);
  expect(gitEvents(deps)[0]!.data).toMatchObject({ id: "s1", git: { state: "open", number: 5 } });
});

test("GET git write-through: an unchanged repoll neither re-writes nor re-emits", async () => {
  const deps = makeDeps(fakeForge());
  const app = makeApp(deps);
  await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect(deps.cacheWrites).toEqual(["s1"]); // only the first GET wrote
  expect(gitEvents(deps)).toHaveLength(1); // and only the first emitted
});

test("GET git write-through: a no-PR none for an uncached session stays silent", async () => {
  const f = fakeForge({
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: true }),
  });
  const deps = makeDeps(f);
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect((await res.json()).state).toBe("none");
  expect(deps.cacheWrites).toEqual([]);
  expect(gitEvents(deps)).toHaveLength(0);
});

test("GET git write-through: clears a stale cached PR once the PR is genuinely gone", async () => {
  const f = fakeForge({
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: true }),
  });
  const deps = makeDeps(f);
  deps.snap.s1 = { kind: "gitea", state: "open", number: 5, checks: "success" } as GitState;
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  expect((await res.json()).state).toBe("none");
  expect(deps.snap.s1?.state).toBe("none");
  expect(gitEvents(deps)).toHaveLength(1);
  expect(gitEvents(deps)[0]!.data).toMatchObject({ id: "s1", git: { state: "none" } });
});

test("GET git write-through: reconciles a renamed branch and surfaces its PR", async () => {
  const heads: string[] = [];
  const f = fakeForge({
    prStatus: async (head: string) => {
      heads.push(head);
      return head === "shepherd/renamed"
        ? { state: "open", number: 7, checks: "pending", deployConfigured: true }
        : { state: "none", checks: "none", deployConfigured: true };
    },
  });
  const deps = makeDeps(f, SESSION, { syncBranch: () => "shepherd/renamed" });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/git"));
  const body = await res.json();
  expect(body.state).toBe("open");
  expect(body.number).toBe(7);
  // stored branch tried first, then the reconciled live branch.
  expect(heads).toEqual(["shepherd/add-feature", "shepherd/renamed"]);
  expect(deps.snap.s1?.number).toBe(7);
  expect(gitEvents(deps)).toHaveLength(1);
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

test("POST git/ready promotes a draft PR and emits refreshed git state", async () => {
  let isDraft = true;
  const f = fakeForge({
    prStatus: async () =>
      ({
        state: "open",
        number: 5,
        checks: "success",
        deployConfigured: true,
        isDraft,
      }) as PrStatus,
    markReady: async (n) => {
      f.log.push(`ready:${n}`);
      isDraft = false;
    },
  });
  const deps = makeDeps(f);
  const app = makeApp(deps);

  const res = await app.fetch(post("/api/sessions/s1/git/ready"));

  expect(res.status).toBe(200);
  expect(f.log).toContain("ready:5");
  expect(await res.json()).toMatchObject({ state: "open", number: 5, isDraft: false });
  expect(deps.cacheWrites).toContain("s1");
  expect(deps.emitted.find((e) => e.event === "session:git")?.data).toMatchObject({
    id: "s1",
    git: { isDraft: false },
  });
});

test("POST git/ready rejects unsigned draft-mode PR before reconciler flips it back", async () => {
  const f = fakeForge({
    prStatus: async () =>
      ({
        state: "open",
        number: 5,
        checks: "success",
        deployConfigured: true,
        isDraft: true,
      }) as PrStatus,
    markReady: async (n) => {
      f.log.push(`ready:${n}`);
    },
  });
  const deps = makeDeps(f, SESSION, { draftMode: true });
  const app = makeApp(deps);

  const res = await app.fetch(post("/api/sessions/s1/git/ready"));

  expect(res.status).toBe(409);
  expect(f.log).not.toContain("ready:5");
  expect(await res.json()).toMatchObject({
    code: "draft_awaiting_signoff",
    error: expect.stringContaining("awaiting sign-off"),
  });
  expect(deps.cacheWrites).toEqual([]);
  expect(deps.emitted.find((e) => e.event === "session:git")).toBeUndefined();
});

test("POST git/ready allows signed draft-mode PR", async () => {
  let isDraft = true;
  const f = fakeForge({
    prStatus: async () =>
      ({
        state: "open",
        number: 5,
        checks: "success",
        deployConfigured: true,
        isDraft,
        latestReview: { state: "approved", author: "reviewer", submittedAt: 1 },
      }) as PrStatus,
    markReady: async (n) => {
      f.log.push(`ready:${n}`);
      isDraft = false;
    },
  });
  const app = makeApp(makeDeps(f, SESSION, { draftMode: true }));

  const res = await app.fetch(post("/api/sessions/s1/git/ready"));

  expect(res.status).toBe(200);
  expect(f.log).toContain("ready:5");
  expect(await res.json()).toMatchObject({ state: "open", number: 5, isDraft: false });
});

test("POST git/draft converts a ready PR back to draft", async () => {
  let isDraft = false;
  const f = fakeForge({
    prStatus: async () =>
      ({
        state: "open",
        number: 5,
        checks: "success",
        deployConfigured: true,
        isDraft,
      }) as PrStatus,
    convertToDraft: async (n) => {
      f.log.push(`draft:${n}`);
      isDraft = true;
    },
  });
  const app = makeApp(makeDeps(f));

  const res = await app.fetch(post("/api/sessions/s1/git/draft"));

  expect(res.status).toBe(200);
  expect(f.log).toContain("draft:5");
  expect(await res.json()).toMatchObject({ state: "open", number: 5, isDraft: true });
});

test("POST git/draft → 400 when host cannot change draft state", async () => {
  const f = fakeForge({
    prStatus: async () =>
      ({
        state: "open",
        number: 5,
        checks: "success",
        deployConfigured: true,
        isDraft: false,
      }) as PrStatus,
  });
  const app = makeApp(makeDeps(f));

  const res = await app.fetch(post("/api/sessions/s1/git/draft"));

  expect(res.status).toBe(400);
});

test("POST git/ready → 409 when there is no open PR", async () => {
  const f = fakeForge({
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: true }) as PrStatus,
  });
  const app = makeApp(makeDeps(f));

  const res = await app.fetch(post("/api/sessions/s1/git/ready"));

  expect(res.status).toBe(409);
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

test("GET /api/holds returns the holds snapshot", async () => {
  const snap: Record<string, import("../src/types").HoldReason> = {
    s1: { code: "halted-usage", params: { resetAt: 1700000000000 } },
  };
  const deps = Object.assign(makeDeps(fakeForge()), { holds: { snapshot: () => snap } });
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://localhost/api/holds"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(snap);
});

test("GET /api/holds → {} when no holds dep is wired", async () => {
  const app = makeApp(makeDeps(fakeForge()));
  const res = await app.fetch(new Request("http://localhost/api/holds"));
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
