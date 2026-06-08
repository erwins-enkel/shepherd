import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { PlanGate } from "../src/types";

const g = (over: Partial<PlanGate> = {}): PlanGate => ({
  sessionId: "s1",
  planHash: "h1",
  decision: "changes_requested",
  summary: "x",
  body: "b",
  findings: ["f1"],
  round: 1,
  cap: 3,
  approved: false,
  plan: "PLAN",
  updatedAt: 1,
  ...over,
});

const base = {
  name: "repo-flatten",
  prompt: "flatten repo",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/repo-flatten",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

test("plan_gate CRUD round-trips + snapshot", () => {
  const s = new SessionStore(":memory:");
  expect(s.getPlanGate("s1")).toBeNull();
  s.putPlanGate(g());
  expect(s.getPlanGate("s1")?.findings).toEqual(["f1"]);
  s.putPlanGate(g({ decision: "approved", approved: true, findings: [], round: 0 }));
  expect(s.getPlanGate("s1")?.approved).toBe(true);
  expect(Object.keys(s.snapshotPlanGates())).toEqual(["s1"]);
  s.dropPlanGate("s1");
  expect(s.getPlanGate("s1")).toBeNull();
});

test("repo_config carries planGateEnabled default + setter", () => {
  const s = new SessionStore(":memory:");
  expect(s.getRepoConfig("/r").planGateEnabled).toBe(false);
  s.setRepoConfig("/r", { ...s.getRepoConfig("/r"), planGateEnabled: true });
  expect(s.getRepoConfig("/r").planGateEnabled).toBe(true);
});

test("created session has plan-gate defaults; setPlanPhase updates", () => {
  const s = new SessionStore(":memory:");
  const row = s.create(base);
  expect(row.planPhase).toBeNull();
  expect(row.planGateEnabled).toBeNull();
  s.setPlanPhase(row.id, "planning");
  expect(s.get(row.id)?.planPhase).toBe("planning");
});
