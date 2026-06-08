import { expect, test } from "bun:test";
import { PlanGateService } from "../src/plan-gate";

function harness(over: any = {}) {
  const started: any[] = [];
  const removed: string[] = [];
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
    ...over,
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
