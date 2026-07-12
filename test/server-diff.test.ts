import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";

const SESSION: Session = {
  id: "s1",
  desig: "TASK-01",
  name: "Add feature",
  prompt: "Add the feature",
  repoPath: "/repo",
  baseBranch: "main",
  branch: null, // null branch → empty result, no git shell-out needed
  worktreePath: "/wt",
  isolated: false,
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

function makeDeps(session: Session | null, prCache?: AppDeps["prCache"]): AppDeps {
  const store: Partial<SessionStore> = {
    get: (id) => (session && id === session.id ? session : null),
  };
  return {
    store: store as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    prCache,
  };
}

test("GET /api/sessions/:id/diff → empty result for a non-isolated session", async () => {
  const app = makeApp(makeDeps(SESSION));
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/diff"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.head).toBeNull();
  expect(body.files).toEqual([]);
  expect(body.base).toBe("main");
});

test("GET /api/sessions/:id/diff → prefers the PR's cached base over session.baseBranch", async () => {
  // Session stored baseBranch="main" but its PR actually targets "release-1.2" (the TASK-852 shape:
  // base diverges from the stored default). The diff must reflect the PR's base. Using a null-branch
  // session keeps computeDiff side-effect-free while still threading the resolved base into the result.
  const prCache = {
    snapshot: () => ({}),
    get: () =>
      ({ kind: "github", state: "open", checks: "none", baseRefName: "release-1.2" }) as never,
    set: () => {},
    drop: () => {},
  };
  const app = makeApp(makeDeps(SESSION, prCache));
  const res = await app.fetch(new Request("http://localhost/api/sessions/s1/diff"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.base).toBe("release-1.2"); // PR base, NOT the stored "main"
});

test("GET /api/sessions/:id/diff → 404 when session unknown", async () => {
  const app = makeApp(makeDeps(null));
  const res = await app.fetch(new Request("http://localhost/api/sessions/nope/diff"));
  expect(res.status).toBe(404);
});
