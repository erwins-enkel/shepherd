import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { SessionUsageBucket, SessionUsageSnapshot } from "../src/types";

const snap = (over: Partial<SessionUsageSnapshot> = {}): SessionUsageSnapshot => ({
  sessionId: "sess-1",
  desig: "TASK-01",
  name: "round-trip-fields",
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
  rawByModel: { "claude-sonnet-4-5": 1750 },
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
  expect(r.name).toBe("round-trip-fields");
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
  expect(r.rawByModel).toEqual({ "claude-sonnet-4-5": 1750 });
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

// ── session_usage_bucket tests ────────────────────────────────────────────────

/** Helper: minimal bucket fixture. */
const bucket = (over: Partial<SessionUsageBucket> = {}): SessionUsageBucket => ({
  sessionId: "sess-1",
  bucketStart: 3_600_000,
  input: 100,
  output: 50,
  cacheRead: 20,
  cacheWrite: 5,
  weightedUnits: 1.5,
  cacheReadUnits: 0.1,
  byModel: { "claude-sonnet-4-5": 1.5 },
  rawByModel: { "claude-sonnet-4-5": 175 },
  ...over,
});

test("session_usage_bucket: replaceSessionUsageBuckets inserts and round-trips rows", () => {
  const s = new SessionStore(":memory:");
  // Parent row required for FK
  s.upsertSessionUsage(snap());
  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ bucketStart: 0 }),
    bucket({ bucketStart: 3_600_000, input: 200 }),
  ]);
  const ids = s.bucketedSessionIds();
  expect(ids.has("sess-1")).toBe(true);
  expect(ids.size).toBe(1);
});

test("session_usage_bucket: replaceSessionUsageBuckets is idempotent — no PK error, old rows replaced", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());
  s.replaceSessionUsageBuckets("sess-1", [bucket({ input: 100 })]);
  // Re-call with updated data for the same bucketStart — must not throw PK error
  s.replaceSessionUsageBuckets("sess-1", [bucket({ input: 999 })]);
  // Only the new data should survive
  const sums = s.sumSessionUsageBucketsSince(0);
  expect(sums.get("sess-1")!.input).toBe(999);
});

test("session_usage_bucket: empty buckets array clears session rows", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());
  s.replaceSessionUsageBuckets("sess-1", [bucket()]);
  expect(s.bucketedSessionIds().has("sess-1")).toBe(true);
  s.replaceSessionUsageBuckets("sess-1", []);
  expect(s.bucketedSessionIds().has("sess-1")).toBe(false);
});

test("session_usage_bucket: FK CASCADE — deleting session_usage parent removes buckets", () => {
  const s = new SessionStore(":memory:");
  // Must create parent before inserting buckets
  s.upsertSessionUsage(snap());
  s.replaceSessionUsageBuckets("sess-1", [bucket(), bucket({ bucketStart: 7_200_000 })]);
  expect(s.bucketedSessionIds().has("sess-1")).toBe(true);
  // Delete parent — CASCADE should wipe child rows
  (s as unknown as { db: import("bun:sqlite").Database }).db.run(
    `DELETE FROM session_usage WHERE sessionId = ?`,
    ["sess-1"],
  );
  expect(s.bucketedSessionIds().has("sess-1")).toBe(false);
});

test("session_usage_bucket: sumSessionUsageBucketsSince includes bucket 0 and buckets >= floorHour(cutoff)", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());

  const H = 3_600_000; // one hour in ms
  // hour 1 = 1H, hour 2 = 2H, hour 3 = 3H; plus timeless bucket 0
  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ bucketStart: 0, input: 10, weightedUnits: 0.1 }),
    bucket({ bucketStart: 1 * H, input: 20, weightedUnits: 0.2 }),
    bucket({ bucketStart: 2 * H, input: 30, weightedUnits: 0.3 }),
    bucket({ bucketStart: 3 * H, input: 40, weightedUnits: 0.4 }),
  ]);

  // cutoff at 2H + 1ms → floorHour = 2H → includes bucket 0 + bucket 2H + bucket 3H
  const cutoff = 2 * H + 1;
  const sums = s.sumSessionUsageBucketsSince(cutoff);
  const w = sums.get("sess-1")!;
  // bucket 0 (10) + bucket 2H (30) + bucket 3H (40) = 80; bucket 1H excluded
  expect(w.input).toBe(80);
  expect(w.weightedUnits).toBeCloseTo(0.8, 10);
});

test("session_usage_bucket: sumSessionUsageBucketsSince merges byModel across rows", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());

  const H = 3_600_000;
  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ bucketStart: 0, byModel: { sonnet: 1.0, opus: 0.5 } }),
    bucket({ bucketStart: 2 * H, byModel: { sonnet: 2.0 } }),
    bucket({ bucketStart: 3 * H, byModel: { haiku: 0.3 } }),
  ]);

  const sums = s.sumSessionUsageBucketsSince(2 * H);
  const bm = sums.get("sess-1")!.byModel;
  expect(bm["sonnet"]).toBeCloseTo(3.0, 10); // 1.0 + 2.0
  expect(bm["opus"]).toBeCloseTo(0.5, 10); // only in bucket 0
  expect(bm["haiku"]).toBeCloseTo(0.3, 10); // bucket 3H
});

test("session_usage_bucket: sumSessionUsageBucketsSince merges rawByModel across rows", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());

  const H = 3_600_000;
  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ bucketStart: 0, rawByModel: { sonnet: 100, opus: 50 } }),
    bucket({ bucketStart: 2 * H, rawByModel: { sonnet: 200 } }),
    bucket({ bucketStart: 3 * H, rawByModel: { haiku: 30 } }),
  ]);

  expect(s.sumSessionUsageBucketsSince(2 * H).get("sess-1")!.rawByModel).toEqual({
    sonnet: 300,
    opus: 50,
    haiku: 30,
  });
});

test("legacy empty rawByModel falls back to unknown raw token totals", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap({ rawByModel: {} }));
  expect(s.listSessionUsage()[0]!.rawByModel).toEqual({ unknown: 1750 });

  s.replaceSessionUsageBuckets("sess-1", [bucket({ rawByModel: {} })]);
  expect(s.sumSessionUsageBucketsSince(0).get("sess-1")!.rawByModel).toEqual({ unknown: 175 });
});

test("legacy usage tables migrate rawByModel columns and preserve totals as unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-usage-model-migration-"));
  const dbPath = join(dir, "test.db");
  try {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE session_usage (
        sessionId TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        repoPath TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL,
        output INTEGER NOT NULL, cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL,
        total INTEGER NOT NULL, weightedUnits REAL NOT NULL, cacheReadUnits REAL NOT NULL,
        messageCount INTEGER NOT NULL, byModel TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL, archivedAt INTEGER NOT NULL, snapshotAt INTEGER NOT NULL
      );
      CREATE TABLE session_usage_bucket (
        sessionId TEXT NOT NULL, bucketStart INTEGER NOT NULL, input INTEGER NOT NULL,
        output INTEGER NOT NULL, cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL,
        weightedUnits REAL NOT NULL, cacheReadUnits REAL NOT NULL,
        byModel TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (sessionId, bucketStart),
        FOREIGN KEY (sessionId) REFERENCES session_usage(sessionId) ON DELETE CASCADE
      );
      INSERT INTO session_usage VALUES (
        'legacy', 'TASK-00', 'legacy', '/repos/legacy', 'claude-sonnet-4-5',
        100, 50, 20, 5, 175, 1.5, 0.1, 1, '{}', 1, 2, 3
      );
      INSERT INTO session_usage_bucket VALUES (
        'legacy', 0, 100, 50, 20, 5, 1.5, 0.1, '{}'
      );
    `);
    raw.close();

    const s = new SessionStore(dbPath);
    const db = (s as unknown as { db: Database }).db;
    const usageColumns = db.query(`PRAGMA table_info(session_usage)`).all() as { name: string }[];
    const bucketColumns = db.query(`PRAGMA table_info(session_usage_bucket)`).all() as {
      name: string;
    }[];
    expect(usageColumns.some((column) => column.name === "rawByModel")).toBe(true);
    expect(bucketColumns.some((column) => column.name === "rawByModel")).toBe(true);
    expect(s.listSessionUsage()[0]!.rawByModel).toEqual({ unknown: 175 });
    expect(s.sumSessionUsageBucketsSince(0).get("legacy")!.rawByModel).toEqual({ unknown: 175 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_usage_bucket: sumSessionUsageBucketsSince sums multiple sessions independently", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap({ sessionId: "sess-1" }));
  s.upsertSessionUsage(snap({ sessionId: "sess-2" }));

  s.replaceSessionUsageBuckets("sess-1", [bucket({ sessionId: "sess-1", input: 100 })]);
  s.replaceSessionUsageBuckets("sess-2", [bucket({ sessionId: "sess-2", input: 200 })]);

  const sums = s.sumSessionUsageBucketsSince(0);
  expect(sums.get("sess-1")!.input).toBe(100);
  expect(sums.get("sess-2")!.input).toBe(200);
  expect(sums.size).toBe(2);
});

test("session_usage_bucket: sumSessionUsageBucketsSince excludes buckets before floorHour(cutoff)", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());

  const H = 3_600_000;
  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ bucketStart: 1 * H, input: 10 }),
    bucket({ bucketStart: 2 * H, input: 20 }),
  ]);

  // cutoff = 2H → only bucket 2H included; bucket 1H is excluded
  const sums = s.sumSessionUsageBucketsSince(2 * H);
  expect(sums.get("sess-1")!.input).toBe(20);
});

test("session_usage_bucket: sumSessionUsageBucketsSince cutoff=0 => floorHour=0 => only bucket 0 matches bucketStart=0", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap());

  const H = 3_600_000;
  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ bucketStart: 0, input: 5 }),
    bucket({ bucketStart: 1 * H, input: 50 }),
  ]);

  // cutoff=0 → floorHour=0 → WHERE bucketStart=0 OR bucketStart>=0 → ALL rows
  const sums = s.sumSessionUsageBucketsSince(0);
  expect(sums.get("sess-1")!.input).toBe(55);
});

test("session_usage_bucket: bucketedSessionIds returns distinct set", () => {
  const s = new SessionStore(":memory:");
  s.upsertSessionUsage(snap({ sessionId: "sess-1" }));
  s.upsertSessionUsage(snap({ sessionId: "sess-2" }));

  s.replaceSessionUsageBuckets("sess-1", [
    bucket({ sessionId: "sess-1", bucketStart: 0 }),
    bucket({ sessionId: "sess-1", bucketStart: 3_600_000 }),
  ]);
  s.replaceSessionUsageBuckets("sess-2", [bucket({ sessionId: "sess-2" })]);

  const ids = s.bucketedSessionIds();
  expect(ids.size).toBe(2);
  expect(ids.has("sess-1")).toBe(true);
  expect(ids.has("sess-2")).toBe(true);
  expect(ids.has("sess-3")).toBe(false);
});
