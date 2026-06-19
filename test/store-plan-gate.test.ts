import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { PlanGate } from "../src/types";
import type { VisualBlock } from "../src/visual-blocks";

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

test("putPlanGate/getPlanGate round-trips blocks with inferred flag intact", () => {
  const s = new SessionStore(":memory:");
  const blocks: VisualBlock[] = [
    {
      type: "question-form",
      id: "qf1",
      questions: [{ id: "q1", prompt: "Goal?", kind: "single", options: ["A", "B"] }],
    },
    {
      type: "data-model",
      id: "dm1",
      inferred: true,
      entities: [{ id: "e1", name: "User", fields: [{ name: "id", type: "string", pk: true }] }],
    },
  ];
  s.putPlanGate(g({ sessionId: "s-blocks", blocks }));
  const got = s.getPlanGate("s-blocks");
  expect(got?.blocks).toEqual(blocks);
  // inferred flag on data-model must survive the round-trip
  const dm = got?.blocks?.find((b) => b.type === "data-model") as
    | { inferred?: boolean }
    | undefined;
  expect(dm?.inferred).toBe(true);
});

test("snapshotPlanGates includes blocks for stored gate", () => {
  const s = new SessionStore(":memory:");
  const blocks: VisualBlock[] = [
    {
      type: "question-form",
      id: "qf2",
      questions: [{ id: "q2", prompt: "Scope?", kind: "freeform" }],
    },
  ];
  s.putPlanGate(g({ sessionId: "s-snap", blocks }));
  const snap = s.snapshotPlanGates();
  expect(snap["s-snap"]?.blocks).toEqual(blocks);
});

test("putPlanGate without blocks round-trips as empty array", () => {
  const s = new SessionStore(":memory:");
  // omit blocks entirely — should default to []
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { blocks: _blocks, ...rest } = g() as any;
  s.putPlanGate(rest as PlanGate);
  const got = s.getPlanGate("s1");
  expect(got?.blocks).toEqual([]);
});
