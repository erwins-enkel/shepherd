import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { HeavyJob } from "../src/heavy-slot-core";
import { SessionStore } from "../src/store";

const job = (id: string, over: Partial<HeavyJob> = {}): HeavyJob => ({
  id,
  sessionId: "s1",
  command: "vitest run",
  cwd: null,
  etaKey: "k",
  state: "done",
  enqueuedAt: 1,
  offerExpiresAt: null,
  startedAt: 1,
  finishedAt: 2,
  releasedAt: 2,
  exitCode: 0,
  pgid: null,
  dropReason: null,
  head: "abc",
  treeHash: "t",
  ...over,
});

test("heavy_slot_jobs: revision columns are added to a table created before #3554", () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/slot-old-${crypto.randomUUID()}.db`;
  const old = new Database(path);
  old.run(`CREATE TABLE heavy_slot_jobs (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT,
    etaKey TEXT NOT NULL, state TEXT NOT NULL, enqueuedAt INTEGER NOT NULL,
    offerExpiresAt INTEGER, startedAt INTEGER, finishedAt INTEGER, releasedAt INTEGER,
    exitCode INTEGER, pgid INTEGER, dropReason TEXT)`);
  old.close();
  const s = new SessionStore(path);
  s.upsertHeavySlotJob(job("j1"));
  expect(s.listHeavySlotJobs(["done"])[0]).toMatchObject({ head: "abc", treeHash: "t" });
});

test("heavy_slot_jobs: the revision survives an upsert", () => {
  const s = new SessionStore(":memory:");
  s.upsertHeavySlotJob(job("j1", { state: "running", finishedAt: null, exitCode: null }));
  s.upsertHeavySlotJob(job("j1"));
  expect(s.listHeavySlotJobs(["done"])[0]).toMatchObject({ head: "abc", treeHash: "t" });
});

test("lastHeavySlotResults: newest exited job per session, only with a captured revision", () => {
  const s = new SessionStore(":memory:");
  s.upsertHeavySlotJob(job("old", { finishedAt: 2 }));
  s.upsertHeavySlotJob(job("new", { finishedAt: 5, exitCode: 1 }));
  s.upsertHeavySlotJob(job("running", { state: "running", finishedAt: null, exitCode: null }));
  s.upsertHeavySlotJob(job("legacy", { sessionId: "s2", head: null, treeHash: null }));
  s.upsertHeavySlotJob(job("dropped", { sessionId: "s3", state: "dropped", finishedAt: null }));
  s.upsertHeavySlotJob(job("lingering", { sessionId: "s4", state: "lingering", releasedAt: null }));
  const got = s
    .lastHeavySlotResults()
    .map((j) => j.id)
    .sort();
  expect(got).toEqual(["lingering", "new"]);
});
