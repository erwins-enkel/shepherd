import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("plan_gate round-trips finalRoundPending + dismissed (legacy rows default false)", () => {
  const s = new SessionStore(":memory:");
  // A fresh in-loop gate omits both → hydrate treats absent as falsy.
  s.putPlanGate(g());
  expect(s.getPlanGate("s1")?.finalRoundPending).toBeFalsy();
  expect(s.getPlanGate("s1")?.dismissed).toBeFalsy();
  // Set both and confirm they persist.
  s.putPlanGate(g({ finalRoundPending: true, dismissed: true }));
  expect(s.getPlanGate("s1")?.finalRoundPending).toBe(true);
  expect(s.getPlanGate("s1")?.dismissed).toBe(true);
  expect(s.snapshotPlanGates().s1!.dismissed).toBe(true);
});

test("plan_gate: summaryCode round-trips (error → sentinel code, non-error → null) (#1628)", () => {
  const s = new SessionStore(":memory:");
  s.putPlanGate(
    g({
      sessionId: "err",
      decision: "error",
      summary: "",
      summaryCode: "no-verdict",
      findings: [],
      round: 0,
    }),
  );
  expect(s.getPlanGate("err")?.summaryCode).toBe("no-verdict");
  expect(s.getPlanGate("err")?.summary).toBe("");
  expect(s.snapshotPlanGates()["err"]?.summaryCode).toBe("no-verdict");
  // A non-error gate carries the reviewer's own summary and no code.
  s.putPlanGate(
    g({
      sessionId: "ok",
      decision: "approved",
      approved: true,
      summary: "looks good",
      findings: [],
      round: 0,
    }),
  );
  expect(s.getPlanGate("ok")?.summaryCode).toBeNull();
  expect(s.getPlanGate("ok")?.summary).toBe("looks good");
});

test("plan_gate: legacy-prose migration flips known error prose to the code, no-clobber + idempotent (#1628)", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "shepherd-pg-")), "test.db");
  {
    const s = new SessionStore(dbPath);
    // Simulate two pre-migration `error` rows (summaryCode still NULL): one bakes the EXACT known
    // English prose (must migrate), one has a different reviewer message (must NOT be clobbered).
    const db = (s as unknown as { db: { run: (sql: string) => void } }).db;
    db.run(
      `INSERT INTO plan_gates (sessionId, decision, summary, updatedAt) VALUES ('legacy','error','plan reviewer did not produce a verdict',1)`,
    );
    db.run(
      `INSERT INTO plan_gates (sessionId, decision, summary, updatedAt) VALUES ('other','error','some other reviewer message',1)`,
    );
    expect(s.getPlanGate("legacy")?.summaryCode).toBeNull(); // not migrated yet (raw insert)
  }
  // Re-open → migratePlanGateColumns re-runs the legacy-prose UPDATE.
  {
    const s = new SessionStore(dbPath);
    expect(s.getPlanGate("legacy")?.summaryCode).toBe("no-verdict"); // flipped to the code
    expect(s.getPlanGate("legacy")?.summary).toBe(""); // prose cleared
    expect(s.getPlanGate("other")?.summaryCode).toBeNull(); // untouched — no clobber
    expect(s.getPlanGate("other")?.summary).toBe("some other reviewer message");
  }
  // Idempotent: a third open changes nothing and never errors.
  {
    const s = new SessionStore(dbPath);
    expect(s.getPlanGate("legacy")?.summaryCode).toBe("no-verdict");
    expect(s.getPlanGate("other")?.summary).toBe("some other reviewer message");
  }
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
    { inferred?: boolean } | undefined;
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
