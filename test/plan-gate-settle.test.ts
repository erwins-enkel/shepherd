import { expect, test } from "bun:test";
import { PlanGateService, shouldCheckPlanDrift, shouldConsiderOnSettle } from "../src/plan-gate";
import type { PlanGate, Session } from "../src/types";

test("shouldConsiderOnSettle truth table", () => {
  const planning: Session["planPhase"] = "planning";
  const executing: Session["planPhase"] = "executing";

  expect(shouldConsiderOnSettle("done", planning, undefined)).toBe(true);
  expect(shouldConsiderOnSettle("done", planning, "changes_requested")).toBe(true);
  expect(shouldConsiderOnSettle("idle", planning, "changes_requested")).toBe(true);
  expect(shouldConsiderOnSettle("idle", planning, "error")).toBe(false);
  expect(shouldConsiderOnSettle("idle", planning, "approved")).toBe(false);
  expect(shouldConsiderOnSettle("idle", planning, undefined)).toBe(false);
  expect(shouldConsiderOnSettle("running", planning, "changes_requested")).toBe(false);
  expect(shouldConsiderOnSettle("blocked", planning, "changes_requested")).toBe(false);
  expect(shouldConsiderOnSettle("done", executing, "changes_requested")).toBe(false);
  expect(shouldConsiderOnSettle("idle", null, "changes_requested")).toBe(false);
});

test("#2224: shouldCheckPlanDrift fires on a settle edge only, and only for an approved gate", () => {
  const approved = { approved: true } as PlanGate;
  const rework = { approved: false } as PlanGate;

  expect(shouldCheckPlanDrift("idle", approved)).toBe(true);
  expect(shouldCheckPlanDrift("done", approved)).toBe(true);
  // Mid-turn edges never read the file — this runs on the single server loop.
  expect(shouldCheckPlanDrift("running", approved)).toBe(false);
  expect(shouldCheckPlanDrift("blocked", approved)).toBe(false);
  // Before approval the plan is EXPECTED to move; that is shouldConsiderOnSettle's job.
  expect(shouldCheckPlanDrift("idle", rework)).toBe(false);
  expect(shouldCheckPlanDrift("idle", undefined)).toBe(false);
  expect(shouldCheckPlanDrift("idle", null)).toBe(false);
});

test("#2224: noteLivePlan records divergence once, leaves the verdict fields alone", async () => {
  const gates: PlanGate[] = [];
  const changes: string[] = [];
  let plan = "APPROVED PLAN";
  const approvedHash = await PlanGateService.hashPlan("APPROVED PLAN");
  let stored: PlanGate = {
    sessionId: "s1",
    planHash: approvedHash,
    decision: "approved",
    summary: "ok",
    body: "B",
    findings: [],
    round: 0,
    cap: 3,
    approved: true,
    plan: "APPROVED PLAN",
    approvedAt: 500,
    livePlanHash: approvedHash,
    updatedAt: 900,
  };
  const svc = new PlanGateService({
    store: {
      getPlanGate: () => stored,
      putPlanGate: (g: PlanGate) => {
        stored = g;
        gates.push(g);
      },
    },
    readPlan: () => plan,
    onChange: (id: string) => changes.push(id),
    now: () => 5000,
  } as never as ConstructorParameters<typeof PlanGateService>[0]);
  const session = { id: "s1", worktreePath: "/wt" } as Session;

  // Unchanged plan → churn-guarded: no write, no WS emit.
  await svc.noteLivePlan(session);
  expect(gates.length).toBe(0);
  expect(changes.length).toBe(0);

  // Edited → one write carrying ONLY the new live hash.
  plan = "REWRITTEN PLAN";
  await svc.noteLivePlan(session);
  expect(gates.length).toBe(1);
  expect(changes).toEqual(["s1"]);
  expect(gates[0]!.livePlanHash).toBe(await PlanGateService.hashPlan("REWRITTEN PLAN"));
  expect(gates[0]!.planHash).toBe(approvedHash); // approved snapshot untouched
  expect(gates[0]!.approved).toBe(true);
  expect(gates[0]!.plan).toBe("APPROVED PLAN");
  // updatedAt dates the VERDICT — planStallStatus and adoptOrphans' re-review check both read it.
  expect(gates[0]!.updatedAt).toBe(900);

  // Settling again on the same edited text writes nothing further.
  await svc.noteLivePlan(session);
  expect(gates.length).toBe(1);
});

test("#2224: noteLivePlan ignores a non-approved gate and an unreadable plan", async () => {
  const writes: PlanGate[] = [];
  const make = (gate: PlanGate | null, plan: string | null) =>
    new PlanGateService({
      store: { getPlanGate: () => gate, putPlanGate: (g: PlanGate) => writes.push(g) },
      readPlan: () => plan,
      onChange() {},
    } as never as ConstructorParameters<typeof PlanGateService>[0]);
  const session = { id: "s1", worktreePath: "/wt" } as Session;

  await make(null, "PLAN").noteLivePlan(session);
  await make({ approved: false, planHash: "x" } as PlanGate, "PLAN").noteLivePlan(session);
  // An unreadable/empty artifact is not evidence the plan changed — keep the last known marker.
  await make(
    { approved: true, planHash: "x", livePlanHash: "x" } as PlanGate,
    "  \n ",
  ).noteLivePlan(session);
  await make({ approved: true, planHash: "x", livePlanHash: "x" } as PlanGate, null).noteLivePlan(
    session,
  );
  expect(writes.length).toBe(0);
});
