import { expect, test } from "bun:test";
import { PlanGateService } from "../src/plan-gate";

function harness(over: any = {}) {
  const started: any[] = [];
  const removed: string[] = [];
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
      createDetached: () => ({ worktreePath: "/wt-detached", branch: "main" }),
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
  return { deps, started, removed, store, svc: new PlanGateService(deps) };
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
  await h.svc.consider(planningSession() as any);
  expect(h.started.length).toBe(1);
  expect(h.started[0].argv[h.started[0].argv.length - 1]).toContain("PLAN TEXT");
  expect(h.svc.reviewingIds()).toEqual(["s1"]);
});
test("consider no-ops when plan missing/empty", async () => {
  const h = harness({ readPlan: () => null });
  await h.svc.consider(planningSession() as any);
  expect(h.started.length).toBe(0);
});
test("consider no-ops when session is not in planning phase", async () => {
  const h = harness();
  await h.svc.consider({ ...planningSession(), planPhase: "executing" } as any);
  expect(h.started.length).toBe(0);
});
test("consider dedupes an unchanged plan hash", async () => {
  const hash = await PlanGateService.hashPlan("PLAN TEXT");
  const h = harness({ store: { getPlanGate: () => ({ planHash: hash, approved: false }) } });
  await h.svc.consider(planningSession() as any);
  expect(h.started.length).toBe(0);
});
test("consider no-ops when already approved", async () => {
  const h = harness({ store: { getPlanGate: () => ({ planHash: "other", approved: true }) } });
  await h.svc.consider(planningSession() as any);
  expect(h.started.length).toBe(0);
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
test("timeout with no verdict → error gate, reaped, not released", async () => {
  let t = 1000;
  const h = harness({ readVerdict: () => null, now: () => t });
  await h.svc.consider(planningSession() as any); // startedAt = 1000
  t = 1000 + 11 * 60 * 1000; // exceed default 10m timeout
  await h.svc.tick();
  expect(h.store.gate.decision).toBe("error");
  expect(h.removed).toContain("/wt-detached");
});
