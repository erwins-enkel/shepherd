import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { SessionUsageSnapshot } from "../src/types";

const snap = (over: Partial<SessionUsageSnapshot> = {}): SessionUsageSnapshot => ({
  sessionId: "sess-1",
  desig: "TASK-01",
  repoPath: "/repos/foo",
  model: "claude-sonnet-4-5",
  input: 1000,
  output: 500,
  cacheRead: 200,
  cacheWrite: 50,
  total: 1750,
  weightedUnits: 3.14,
  cacheReadUnits: 0.25,
  messageCount: 10,
  byModel: { "claude-sonnet-4-5": 3.14 },
  createdAt: 1_000_000,
  archivedAt: 2_000_000,
  snapshotAt: 2_000_001,
  ...over,
});

test("session_usage: upsert then list round-trips all fields", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());
  const rows = s.listSessionUsage();
  expect(rows).toHaveLength(1);
  const r = rows[0]!;
  expect(r.sessionId).toBe("sess-1");
  expect(r.desig).toBe("TASK-01");
  expect(r.repoPath).toBe("/repos/foo");
  expect(r.model).toBe("claude-sonnet-4-5");
  expect(r.input).toBe(1000);
  expect(r.output).toBe(500);
  expect(r.cacheRead).toBe(200);
  expect(r.cacheWrite).toBe(50);
  expect(r.total).toBe(1750);
  expect(r.weightedUnits).toBe(3.14);
  expect(r.cacheReadUnits).toBe(0.25);
  expect(r.messageCount).toBe(10);
  expect(r.byModel).toEqual({ "claude-sonnet-4-5": 3.14 });
  expect(r.createdAt).toBe(1_000_000);
  expect(r.archivedAt).toBe(2_000_000);
  expect(r.snapshotAt).toBe(2_000_001);
});

test("session_usage: upserting same sessionId twice yields one row with second value", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap({ total: 100, weightedUnits: 1.0 }));
  s.upsertSessionUsage(
    snap({ total: 999, weightedUnits: 9.9, byModel: { "claude-opus-4-5": 9.9 } }),
  );
  const rows = s.listSessionUsage();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.total).toBe(999);
  expect(rows[0]!.weightedUnits).toBe(9.9);
  expect(rows[0]!.byModel).toEqual({ "claude-opus-4-5": 9.9 });
});

test("session_usage: listSessionUsage on empty table returns []", () => {
  const s = new SessionStore(":memory:");
  expect(s.listSessionUsage()).toEqual([]);
});
