import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session, ReviewVerdict, PlanGate } from "../src/types";
import type { GitForge, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";
import type { PrCache } from "../src/pr-poller";

const ORIGIN = "http://localhost";

/** A finished (idle) session — quota checks require non-running status. */
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
  status: "done", // idle so quotaBlockReason can fire
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

/** A ReviewVerdict that triggers the "rework" quota kind (addressRound >= addressCap, no pending). */
const REWORK_VERDICT: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  patchId: "p1",
  decision: "changes_requested",
  summary: "fix it",
  body: "body",
  findings: ["finding 1"],
  addressRound: 3,
  addressCap: 3,
  streakReviews: 1,
  reviewedPatchIds: [],
  errorRound: 0,
  finalRoundPending: false,
  finalRoundTimeoutMs: 60000,
  seenNoteIds: [],
  updatedAt: 0,
};

/** A PlanGate that triggers the "plan" quota kind (round >= cap, decision = changes_requested). */
const PLAN_GATE: PlanGate = {
  sessionId: "s1",
  planHash: "h1",
  decision: "changes_requested",
  summary: "revise plan",
  body: "body",
  findings: ["finding 1"],
  round: 5,
  cap: 5,
  approved: false,
  plan: "the plan",
  updatedAt: 0,
};

function fakeForge(state: PrStatus["state"] = "open", throws = false): GitForge {
  return {
    kind: "gitea",
    slug: "team/proj",
    mergeMethod: "squash",
    deployWorkflow: "deploy.yaml",
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => {
      if (throws) throw new Error("forge boom");
      return { state, number: 5, checks: "success", deployConfigured: true } as PrStatus;
    },
    openPr: async () => ({ state: "open", number: 5, checks: "pending", deployConfigured: true }),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
}

interface StubOpts {
  session?: Session | null;
  review?: ReviewVerdict | null;
  gate?: PlanGate | null;
  forge?: GitForge | null;
  reviewTrigger?: AppDeps["reviewTrigger"];
  planGate?: AppDeps["planGate"];
}

function makeDeps(opts: StubOpts = {}): AppDeps {
  const { session = SESSION, review = null, gate = null, forge = null } = opts;
  const snap: Record<string, any> = {};
  const prCache: PrCache = {
    snapshot: () => snap,
    get: () => undefined,
    set: () => {},
    drop: () => {},
  };
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
    getReview: (id) => (session && id === session.id ? review : null),
    getPlanGate: (id) => (session && id === session.id ? gate : null),
    getRepoConfig: () => ({}) as any,
  };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => forge,
    prCache,
    reviewTrigger: opts.reviewTrigger,
    planGate: opts.planGate,
  };
}

function post(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
  });
}

// ── POST /quota/resume ────────────────────────────────────────────────────────

test("quota/resume → 404 for unknown session id", async () => {
  const app = makeApp(makeDeps({ session: null }));
  const res = await app.fetch(post("/api/sessions/nope/quota/resume"));
  expect(res.status).toBe(404);
});

test("quota/resume → 202 status:not-stalled when session is not blocked", async () => {
  // review=null, gate=null → quotaBlockReason returns null
  const app = makeApp(makeDeps({ review: null, gate: null }));
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "not-stalled" });
});

test("quota/resume, plan kind → calls planGate.resume, status:resumed when it returns true", async () => {
  const resumed: Session[] = [];
  const planGate: AppDeps["planGate"] = {
    consider: async () => "skipped" as const,
    resume: async (s) => {
      resumed.push(s);
      return true;
    },
    dismiss: () => {},
  };
  const app = makeApp(
    makeDeps({ session: { ...SESSION, planPhase: "planning" }, gate: PLAN_GATE, planGate }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "resumed" });
  expect(resumed.length).toBe(1);
  expect(resumed[0]!.id).toBe("s1");
});

test("quota/resume, plan kind → status:unreachable when planGate.resume returns false", async () => {
  const planGate: AppDeps["planGate"] = {
    consider: async () => "skipped" as const,
    resume: async () => false,
    dismiss: () => {},
  };
  const app = makeApp(
    makeDeps({ session: { ...SESSION, planPhase: "planning" }, gate: PLAN_GATE, planGate }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "unreachable" });
});

test("quota/resume, critic kind → 404 when no forge for repo", async () => {
  const app = makeApp(makeDeps({ review: REWORK_VERDICT, forge: null }));
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(404);
  expect((await res.json()).error).toContain("no forge");
});

test("quota/resume, critic kind, open PR → calls reviewTrigger.force, passes status through", async () => {
  const calls: Session[] = [];
  const reviewTrigger: AppDeps["reviewTrigger"] = {
    force: async (s) => {
      calls.push(s);
      return "started";
    },
    clearStallState: () => {},
  };
  const app = makeApp(
    makeDeps({ review: REWORK_VERDICT, forge: fakeForge("open"), reviewTrigger }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "started" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.id).toBe("s1");
});

test("quota/resume, critic kind, merged PR → calls clearStallState, status:pr-merged, force NOT called", async () => {
  const cleared: Session[] = [];
  const forced: Session[] = [];
  const reviewTrigger: AppDeps["reviewTrigger"] = {
    force: async (s) => {
      forced.push(s);
      return "started";
    },
    clearStallState: (s) => {
      cleared.push(s);
    },
  };
  const app = makeApp(
    makeDeps({ review: REWORK_VERDICT, forge: fakeForge("merged"), reviewTrigger }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "pr-merged" });
  expect(cleared.length).toBe(1);
  expect(forced.length).toBe(0);
});

test("quota/resume, critic kind, closed PR → status:pr-closed, clearStallState called", async () => {
  const cleared: Session[] = [];
  const reviewTrigger: AppDeps["reviewTrigger"] = {
    force: async () => "started",
    clearStallState: (s) => {
      cleared.push(s);
    },
  };
  const app = makeApp(
    makeDeps({ review: REWORK_VERDICT, forge: fakeForge("closed"), reviewTrigger }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "pr-closed" });
  expect(cleared.length).toBe(1);
});

test("quota/resume, critic kind, forge throws → 502, neither force nor clearStallState called", async () => {
  const cleared: Session[] = [];
  const forced: Session[] = [];
  const reviewTrigger: AppDeps["reviewTrigger"] = {
    force: async (s) => {
      forced.push(s);
      return "started";
    },
    clearStallState: (s) => {
      cleared.push(s);
    },
  };
  const app = makeApp(
    makeDeps({ review: REWORK_VERDICT, forge: fakeForge("open", true), reviewTrigger }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/resume"));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toContain("forge boom");
  expect(cleared.length).toBe(0);
  expect(forced.length).toBe(0);
});

// ── POST /quota/dismiss ───────────────────────────────────────────────────────

test("quota/dismiss → 404 for unknown session id", async () => {
  const app = makeApp(makeDeps({ session: null }));
  const res = await app.fetch(post("/api/sessions/nope/quota/dismiss"));
  expect(res.status).toBe(404);
});

test("quota/dismiss → 202 status:not-stalled when session is not blocked", async () => {
  const app = makeApp(makeDeps({ review: null, gate: null }));
  const res = await app.fetch(post("/api/sessions/s1/quota/dismiss"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "not-stalled" });
});

test("quota/dismiss, critic kind → calls clearStallState, status:dismissed", async () => {
  const cleared: Session[] = [];
  const reviewTrigger: AppDeps["reviewTrigger"] = {
    force: async () => "started",
    clearStallState: (s) => {
      cleared.push(s);
    },
  };
  const app = makeApp(makeDeps({ review: REWORK_VERDICT, reviewTrigger }));
  const res = await app.fetch(post("/api/sessions/s1/quota/dismiss"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "dismissed" });
  expect(cleared.length).toBe(1);
  expect(cleared[0]!.id).toBe("s1");
});

test("quota/dismiss, plan kind → calls planGate.dismiss, status:dismissed", async () => {
  const dismissed: Session[] = [];
  const planGate: AppDeps["planGate"] = {
    consider: async () => "skipped" as const,
    resume: async () => false,
    dismiss: (s) => {
      dismissed.push(s);
    },
  };
  const app = makeApp(
    makeDeps({ session: { ...SESSION, planPhase: "planning" }, gate: PLAN_GATE, planGate }),
  );
  const res = await app.fetch(post("/api/sessions/s1/quota/dismiss"));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "dismissed" });
  expect(dismissed.length).toBe(1);
  expect(dismissed[0]!.id).toBe("s1");
});
