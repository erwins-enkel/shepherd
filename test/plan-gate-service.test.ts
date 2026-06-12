import { expect, test } from "bun:test";
import { PlanGateService } from "../src/plan-gate";

function harness(over: any = {}) {
  const started: any[] = [];
  const removed: string[] = [];
  const recordedSpawns: any[] = [];
  const completedSpawns: any[] = [];
  const overWithoutStore = { ...over };
  delete overWithoutStore.store;
  const store = {
    getPlanGate: () => null,
    putPlanGate(g: any) {
      (store as any).gate = g;
    },
    dropPlanGate() {},
    snapshotPlanGates: () => ({}),
    getRepoConfig: () => ({ planGateEnabled: true }),
    addSignal() {},
    setPlanPhase() {},
    get: () => ({ id: "s1", auto: false }),
    recordReviewerSpawn: (r: any) => recordedSpawns.push(r),
    completeReviewerSpawn: (id: any, u: any, at: any) => completedSpawns.push({ id, u, at }),
    ...(over.store ?? {}),
  };
  const deps: any = {
    store,
    herdr: {
      start: (l: string, cwd: string, argv: string[]) => {
        started.push({ l, cwd, argv });
        return { terminalId: "t1" };
      },
      stop() {},
    },
    worktree: {
      createDetached: async () => ({ worktreePath: "/wt-detached", branch: "main" }),
      remove: (p: string) => removed.push(p),
    },
    reply: () => true,
    release() {},
    onChange() {},
    onReviewing() {},
    cap: 3,
    now: () => 1000,
    readPlan: () => "PLAN TEXT",
    readVerdict: () => null,
    baseSha: () => "abc",
    // `store` is already merged above (base + over.store); exclude it here so the
    // deps-level spread doesn't re-overwrite it with the un-merged per-test partial.
    ...overWithoutStore,
  };
  return {
    deps,
    started,
    removed,
    recordedSpawns,
    completedSpawns,
    store,
    svc: new PlanGateService(deps),
  };
}

const planningSession = () => ({
  id: "s1",
  desig: "TASK-01",
  repoPath: "/r",
  baseBranch: "main",
  worktreePath: "/wt",
  prompt: "do X",
  planPhase: "planning",
});

test("consider spawns reviewer when a plan exists and is unreviewed", async () => {
  const h = harness();
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("started"); // relayed to the on-demand route as { status: "started" }
  expect(h.started.length).toBe(1);
  expect(h.started[0].argv[h.started[0].argv.length - 1]).toContain("PLAN TEXT");
  expect(h.svc.reviewingIds()).toEqual(["s1"]);
});
test("consider no-ops when plan missing/empty", async () => {
  const h = harness({ readPlan: () => null });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(0);
});
test("consider no-ops when session is not in planning phase", async () => {
  const h = harness();
  const status = await h.svc.consider({ ...planningSession(), planPhase: "executing" } as any);
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(0);
});
test("consider dedupes an unchanged plan hash", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: false }) } });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped"); // route reports "skipped" so the UI explains the no-op
  expect(h.started.length).toBe(0);
});
test("consider no-ops when already approved", async () => {
  const h = harness({ store: { getPlanGate: () => ({ planHash: "other", approved: true }) } });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("skipped");
  expect(h.started.length).toBe(0);
});
test("consider re-reviews an error verdict even when the plan hash is unchanged", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({
    store: { getPlanGate: () => ({ planHash: hash, approved: false, decision: "error" }) },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("started");
  expect(h.started.length).toBe(1); // an error verdict is retried, not deduped away
});
test("consider reports 'error' (not a dedupe) when the reviewer fails to spawn", async () => {
  const h = harness({
    herdr: {
      start: () => {
        throw new Error("spawn boom");
      },
      stop() {},
    },
  });
  const status = await h.svc.consider(planningSession() as any);
  expect(status).toBe("error"); // UI shows a failure note, not "plan unchanged"
  expect(h.started.length).toBe(0);
  expect(h.removed).toEqual(["/wt-detached"]); // the detached worktree is reaped on failure
});
test("consider won't double-spawn while one is in flight", async () => {
  const h = harness();
  await Promise.all([
    h.svc.consider(planningSession() as any),
    h.svc.consider(planningSession() as any),
  ]);
  expect(h.started.length).toBe(1);
});

test("approve → stores approved gate, reaps worktree+terminal, reviewing off; auto session auto-released", async () => {
  const released: string[] = [];
  const reviewingEvents: any[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    onReviewing: (id: string, r: boolean) => reviewingEvents.push([id, r]),
    store: { get: () => ({ id: "s1", auto: true }) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.approved).toBe(true);
  expect(h.store.gate.decision).toBe("approved");
  expect(released).toEqual(["s1"]);
  expect(h.removed).toContain("/wt-detached");
  expect(reviewingEvents).toContainEqual(["s1", false]);
  expect(h.svc.reviewingIds()).toEqual([]);
});
test("approve on an interactive session does NOT auto-release", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: { get: () => ({ id: "s1", auto: false }) },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.store.gate.approved).toBe(true);
  expect(released).toEqual([]);
});
test("approve → autopilot override ON (non-drain) auto-releases", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: true, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual(["s1"]);
});
test("approve → autopilot override OFF does NOT auto-release", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: false, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: true }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual([]);
});
test("approve → autopilot inherited from repo default ON auto-releases", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: null, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: true }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual(["s1"]);
});
test("approve → autopilot inherited from repo default OFF does NOT auto-release", async () => {
  const released: string[] = [];
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    release: (id: string) => released.push(id),
    store: {
      get: () => ({ id: "s1", auto: false, autopilotEnabled: null, repoPath: "/r" }),
      getRepoConfig: () => ({ planGateEnabled: true, autopilotEnabled: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(released).toEqual([]);
});
test("request-changes → steers findings to the live agent, round++, not released, not approved", async () => {
  const steers: string[] = [];
  const h = harness({
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix A", "fix B"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(steers.length).toBe(1);
  expect(steers[0]).toContain("fix A");
  expect(steers[0]).toContain("fix B");
  expect(h.store.gate.decision).toBe("changes_requested");
  expect(h.store.gate.round).toBe(1);
  expect(h.store.gate.approved).toBe(false);
});
test("request-changes at cap → stops steering, emits stall signal", async () => {
  const steers: string[] = [];
  const signals: any[] = [];
  const h = harness({
    cap: 1,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["again"],
    }),
    reply: (_id: string, t: string) => {
      steers.push(t);
      return true;
    },
    store: {
      getPlanGate: () => ({ planHash: "x", approved: false, round: 1, findings: ["again"] }),
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(steers.length).toBe(0); // at cap → no steer
  expect(signals.some((s) => s.kind === "stall")).toBe(true);
});
test("request-changes sub-cap but the steer can't land → stall signal, round held", async () => {
  const signals: any[] = [];
  const h = harness({
    cap: 3,
    readVerdict: () => ({
      decision: "request-changes",
      summary: "no",
      body: "B",
      findings: ["fix"],
    }),
    reply: () => false, // dead / unreachable pane — the steer never reaches the agent
    store: {
      addSignal: (s: any) => signals.push(s),
      get: () => ({ id: "s1", auto: false }),
    },
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(signals.some((s) => s.kind === "stall")).toBe(true); // escalates instead of going silent
  expect(h.store.gate.round).toBe(0); // round did not advance (nothing delivered)
});
const lastPrompt = (h: ReturnType<typeof harness>): string => {
  const argv = h.started[0].argv;
  return argv[argv.length - 1];
};
const fakeForge = (getIssue?: any) => ({ getIssue });

test("begin() injects the originating issue body into the reviewer prompt (UNTRUSTED)", async () => {
  const h = harness({
    resolveForge: () => fakeForge(async () => ({ body: "ISSUE_BODY_XYZ" })),
  });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).toContain("ISSUE_BODY_XYZ");
  expect(lastPrompt(h)).toContain("ORIGINATING ISSUE");
});
test("no issue block when issueNumber is null", async () => {
  const h = harness({
    resolveForge: () => fakeForge(async () => ({ body: "ISSUE_BODY_XYZ" })),
  });
  await h.svc.consider({ ...planningSession(), issueNumber: null } as any);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
  expect(lastPrompt(h)).not.toContain("ISSUE_BODY_XYZ");
});
test("degrades cleanly when resolveForge is absent", async () => {
  const h = harness(); // no resolveForge dep
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1); // no throw
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("degrades cleanly when resolveForge returns null", async () => {
  const h = harness({ resolveForge: () => null });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("degrades cleanly when getIssue is absent on the forge", async () => {
  const h = harness({ resolveForge: () => fakeForge(undefined) });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("degrades cleanly when getIssue returns null", async () => {
  const h = harness({ resolveForge: () => fakeForge(async () => null) });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("getIssue throwing never blocks the review (no issue block, still spawns)", async () => {
  const h = harness({
    resolveForge: () =>
      fakeForge(async () => {
        throw new Error("gh boom");
      }),
  });
  await h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  expect(h.started.length).toBe(1);
  expect(lastPrompt(h)).not.toContain("ORIGINATING ISSUE");
});
test("forget() during the getIssue await aborts the spawn and reaps the worktree", async () => {
  // Suspend begin() inside the getIssue fetch, fire forget() (session archived) while it's
  // parked, then let the fetch resolve. begin() must re-check `starting`, NOT spawn, and reap
  // the detached worktree it already allocated.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    resolveForge: () =>
      fakeForge(async () => {
        await gate;
        return { body: "ISSUE_BODY_XYZ" };
      }),
  });
  const considering = h.svc.consider({ ...planningSession(), issueNumber: 42 } as any);
  await Promise.resolve(); // let begin() advance into the parked getIssue await
  h.svc.forget("s1"); // archive mid-fetch → clears the `starting` tombstone
  release();
  await considering;
  expect(h.started.length).toBe(0); // never spawned the reviewer
  expect(h.removed).toEqual(["/wt-detached"]); // the detached worktree was reaped
  expect(h.svc.reviewingIds()).toEqual([]);
});

test("records the plan-gate reviewer spawn on begin()", async () => {
  const h = harness();
  await h.svc.consider(planningSession() as any);
  expect(h.recordedSpawns.length).toBe(1);
  expect(h.recordedSpawns[0]).toMatchObject({
    kind: "plan_gate",
    taskSessionId: "s1",
    worktreePath: "/wt-detached",
  });
  expect(h.recordedSpawns[0].reviewerSessionId).toBeTruthy();
});
test("completes the reviewer spawn's token total on finalize", async () => {
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    messageCount: 1,
    lastActivity: 0,
    byModel: {},
  };
  const h = harness({
    readVerdict: () => ({ decision: "approve", summary: "ok", body: "B", findings: [] }),
    readUsage: async () => usage,
  });
  await h.svc.consider(planningSession() as any);
  await h.svc.tick();
  expect(h.completedSpawns.length).toBe(1);
  expect(h.completedSpawns[0].u.total).toBe(10);
  expect(h.completedSpawns[0].id).toBe(h.recordedSpawns[0].reviewerSessionId);
});
test("timeout with no verdict → error gate, reaped, not released", async () => {
  let t = 1000;
  const h = harness({ readVerdict: () => null, now: () => t });
  await h.svc.consider(planningSession() as any); // startedAt = 1000
  t = 1000 + 11 * 60 * 1000; // exceed default 10m timeout
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("error");
  expect(h.removed).toContain("/wt-detached");
});
