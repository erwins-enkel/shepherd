import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { Session } from "../src/types";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";
import { gitStateChanged } from "../src/pr-poller";

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

function setup(over: Partial<PrStatus> = {}, failure?: string) {
  let current: PrStatus = {
    state: "open",
    number: 42,
    checks: "success",
    deployConfigured: false,
    authorLogin: "author",
    requestedReviewers: [],
    isFork: true,
    ...over,
  };
  const writes: Array<{ number: number; reviewer: string }> = [];
  const events: unknown[] = [];
  let cached: GitState | undefined;
  const forge = {
    kind: "github",
    slug: "upstream/project",
    isFork: true,
    currentUser: async () => "author",
    prStatus: async () => {
      if (failure === "refresh" && writes.length) throw new Error("secret refresh error");
      return current;
    },
    listCollaborators: async () => ({
      logins: ["author", "alice", "bob"],
      unavailable: false,
      source: "assignees",
    }),
    requestReview: async (number: number, reviewer: string) => {
      if (failure && failure !== "refresh") throw new Error(failure);
      writes.push({ number, reviewer });
      current = {
        ...current,
        requestedReviewers: [...(current.requestedReviewers ?? []), reviewer],
      };
    },
  } as unknown as GitForge;
  const deps = {
    store: { get: (id: string) => (id === "s1" ? SESSION : null) },
    service: {},
    usageLimits: { limits: () => ({}) },
    resolveForge: () => forge,
    events: { emit: (_name: string, data: unknown) => events.push(data) },
    prCache: {
      get: () => cached,
      set: (_id: string, value: GitState) => {
        cached = value;
      },
    },
  } as unknown as AppDeps;
  const app = makeApp(deps);
  const request = (body: unknown, id = "s1") =>
    app.fetch(
      new Request(`http://localhost/api/sessions/${id}/git/request-review`, {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { app, request, writes, events, forge, cached: () => cached };
}

test("review candidates GET resolves upstream and does not send notifications", async () => {
  const t = setup();
  const res = await t.app.fetch(new Request("http://localhost/api/sessions/s1/git/reviewers"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    prNumber: 42,
    repoSlug: "upstream/project",
    isFork: true,
    logins: ["author", "alice", "bob"],
    source: "assignees",
    unavailable: false,
    requestedReviewers: [],
    authorLogin: "author",
    defaultReviewer: null,
    isDraft: false,
  });
  expect(t.writes).toEqual([]);
});

test("review request preserves other reviewers and broadcasts fresh git state", async () => {
  const t = setup({ requestedReviewers: ["bob"] });
  const res = await t.request({ prNumber: 42, reviewer: "alice" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(t.writes).toEqual([{ number: 42, reviewer: "alice" }]);
  expect(t.cached()?.requestedReviewers).toEqual(["bob", "alice"]);
  expect(t.events).toHaveLength(1);
});

test("already requested login is a case-insensitive no-op", async () => {
  const t = setup({ requestedReviewers: ["Alice"] });
  expect((await t.request({ prNumber: 42, reviewer: "alice" })).status).toBe(200);
  expect(t.writes).toEqual([]);
});

test.each([
  [{ state: "closed" }, { prNumber: 42, reviewer: "alice" }, 409],
  [{ isDraft: true }, { prNumber: 42, reviewer: "alice" }, 409],
  [{}, { prNumber: 43, reviewer: "alice" }, 409],
  [{}, { prNumber: 42, reviewer: "AUTHOR" }, 400],
  [{}, { prNumber: 42, reviewer: "-option" }, 400],
  [{}, { prNumber: 42, reviewer: "alice,bob" }, 400],
  [{}, { prNumber: 42, reviewer: "alice--bob" }, 400],
  [{}, { prNumber: 42, reviewer: "" }, 400],
  [{}, { prNumber: 0, reviewer: "alice" }, 400],
  [{}, { prNumber: -1, reviewer: "alice" }, 400],
  [{}, null, 400],
  [{}, [], 400],
] as const)("invalid review request %j %j rejects without mutation", async (over, body, status) => {
  const t = setup(over);
  expect((await t.request(body)).status).toBe(status);
  expect(t.writes).toEqual([]);
});

test("review requests reject unknown sessions and unsupported forges", async () => {
  const t = setup();
  expect((await t.request({ prNumber: 42, reviewer: "alice" }, "missing")).status).toBe(404);
  t.forge.requestReview = undefined;
  expect((await t.request({ prNumber: 42, reviewer: "alice" })).status).toBe(400);
  expect(t.writes).toEqual([]);
});

test.each([
  "review_request_forbidden",
  "review_request_invalid_reviewer",
  "secret unexpected stderr",
])("review request error %s is safe for the client", async (failure) => {
  const t = setup({}, failure);
  const response = await t.request({ prNumber: 42, reviewer: "alice" });
  expect(response.status).toBe(
    failure === "review_request_forbidden"
      ? 403
      : failure === "review_request_invalid_reviewer"
        ? 422
        : 502,
  );
  expect(await response.json()).toEqual({
    code: failure.startsWith("review_request_") ? failure : "review_request_failed",
  });
  expect(t.events).toEqual([]);
});

test("failed refresh after accepted request remains a successful notification", async () => {
  const t = setup({}, "refresh");
  const res = await t.request({ prNumber: 42, reviewer: "alice" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, refreshPending: true });
  expect(t.writes).toHaveLength(1);
});

test("git change detection includes review requests and fork/author metadata", () => {
  const prev: GitState = {
    kind: "github",
    state: "open",
    checks: "success",
    deployConfigured: false,
    requestedReviewers: ["alice"],
  };
  expect(gitStateChanged(prev, { ...prev, requestedReviewers: [] })).toBe(true);
  expect(gitStateChanged(prev, { ...prev, isFork: true })).toBe(true);
  expect(gitStateChanged(prev, { ...prev, authorLogin: "author" })).toBe(true);
  expect(gitStateChanged(prev, { ...prev, requestedReviewers: ["alice"] })).toBe(false);
});
