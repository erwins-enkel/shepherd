import { expect, test } from "bun:test";
import { HEAVY_SLOT_JOBS_DDL, SessionStore } from "../src/store";
import { Database } from "bun:sqlite";

const job = (id: string, startedAt: number, sessionId = "s1") => ({
  id,
  sessionId,
  command: "vitest run",
  repoPath: "/r",
  worktreePath: "/w",
  startedAt,
  head: "abc",
  treeHash: "t",
});

test("heavy_slot_jobs: the fresh DDL alone yields every column", () => {
  const db = new Database(":memory:");
  db.run(HEAVY_SLOT_JOBS_DDL);
  const cols = (db.query("PRAGMA table_info(heavy_slot_jobs)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  expect(cols).toEqual([
    "id",
    "sessionId",
    "command",
    "repoPath",
    "worktreePath",
    "startedAt",
    "head",
    "treeHash",
    "endedAt",
    "exitCode",
    "result",
  ]);
});

test("heavy_slot_jobs: exit code decides passed/failed; running jobs are not results", () => {
  const s = new SessionStore(":memory:");
  s.startHeavySlotJob(job("j1", 1));
  expect(s.lastHeavySlotJobBySession()).toEqual([]);
  s.finishHeavySlotJob("j1", { exitCode: 0, endedAt: 2 });
  expect(s.lastHeavySlotJobBySession()[0]).toMatchObject({
    id: "j1",
    result: "passed",
    exitCode: 0,
  });
  s.startHeavySlotJob(job("j2", 3));
  s.finishHeavySlotJob("j2", { exitCode: 1, endedAt: 4 });
  expect(s.lastHeavySlotJobBySession()).toHaveLength(1);
  expect(s.lastHeavySlotJobBySession()[0]).toMatchObject({ id: "j2", result: "failed" });
  s.finishHeavySlotJob("j2", { exitCode: 0, endedAt: 5 });
  expect(s.lastHeavySlotJobBySession()[0]!.result).toBe("failed");
});

test("heavy_slot_jobs: open jobs are closed as aborted", () => {
  const s = new SessionStore(":memory:");
  s.startHeavySlotJob(job("j1", 1));
  expect(s.abortOpenHeavySlotJobs(9)).toBe(1);
  expect(s.lastHeavySlotJobBySession()[0]).toMatchObject({ result: "aborted", endedAt: 9 });
});

test("heavy_slot_jobs: only the newest jobs per session are kept", () => {
  const s = new SessionStore(":memory:");
  for (let i = 0; i < 25; i++) s.startHeavySlotJob(job(`j${i}`, i));
  s.startHeavySlotJob(job("other", 1, "s2"));
  s.abortOpenHeavySlotJobs(99);
  const ids = s
    .lastHeavySlotJobBySession()
    .map((r) => r.id)
    .sort();
  expect(ids).toEqual(["j24", "other"]);
  expect(s.abortOpenHeavySlotJobs(100)).toBe(0);
});
