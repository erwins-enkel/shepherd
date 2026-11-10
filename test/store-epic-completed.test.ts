import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";

test("recordEpicCompleted + listEpicCompleted basic round-trip", () => {
  const s = new SessionStore(":memory:");
  expect(s.listEpicCompleted()).toEqual([]);

  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Epic Alpha",
    completedAt: 1000,
    childrenJson: "[]",
  });

  const list = s.listEpicCompleted();
  expect(list).toHaveLength(1);
  expect(list[0]!.repoPath).toBe("/r");
  expect(list[0]!.parentIssueNumber).toBe(10);
  expect(list[0]!.parentTitle).toBe("Epic Alpha");
  expect(list[0]!.completedAt).toBe(1000);
  expect(list[0]!.childrenJson).toBe("[]");
});

test("listEpicCompleted filters by repoPath", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/a",
    parentIssueNumber: 1,
    parentTitle: "A",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/b",
    parentIssueNumber: 2,
    parentTitle: "B",
    completedAt: 2,
    childrenJson: "[]",
  });

  expect(s.listEpicCompleted("/a")).toHaveLength(1);
  expect(s.listEpicCompleted("/a")[0]!.repoPath).toBe("/a");
  expect(s.listEpicCompleted("/b")).toHaveLength(1);
  expect(s.listEpicCompleted()).toHaveLength(2);
});

test("listEpicCompleted orders by completedAt DESC", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 1,
    parentTitle: "Old",
    completedAt: 100,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 2,
    parentTitle: "New",
    completedAt: 200,
    childrenJson: "[]",
  });

  const list = s.listEpicCompleted("/r");
  expect(list[0]!.completedAt).toBe(200);
  expect(list[1]!.completedAt).toBe(100);
});

test("dismissEpicCompleted removes it from listEpicCompleted", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  expect(s.listEpicCompleted()).toHaveLength(1);

  s.dismissEpicCompleted("/r", 10);
  expect(s.listEpicCompleted()).toHaveLength(0);
});

test("re-recordEpicCompleted after dismiss does NOT resurrect (stays dismissed)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.dismissEpicCompleted("/r", 10);
  expect(s.listEpicCompleted()).toHaveLength(0);

  // re-record should not resurrect
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E updated",
    completedAt: 999,
    childrenJson: "[1]",
  });
  expect(s.listEpicCompleted()).toHaveLength(0);
});

test("recordEpicCompleted upsert refreshes parentTitle/completedAt/childrenJson", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Old",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "New",
    completedAt: 999,
    childrenJson: "[1,2]",
  });

  const list = s.listEpicCompleted();
  expect(list[0]!.parentTitle).toBe("New");
  expect(list[0]!.completedAt).toBe(999);
  expect(list[0]!.childrenJson).toBe("[1,2]");
});

test("dismissedAt IS NULL filter — dismissed epics never appear in list", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 1,
    parentTitle: "A",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 2,
    parentTitle: "B",
    completedAt: 2,
    childrenJson: "[]",
  });
  s.dismissEpicCompleted("/r", 1);

  const list = s.listEpicCompleted("/r");
  expect(list).toHaveLength(1);
  expect(list[0]!.parentIssueNumber).toBe(2);
});

test("fresh recordEpicCompleted defaults landing columns (pending/null/null/0)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingState).toBe("pending");
  expect(row.landingPrNumber).toBe(null);
  expect(row.landingPrUrl).toBe(null);
  expect(row.landingAttempts).toBe(0);
});

test("setEpicLandingPr writes the landing resolution", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  s.setEpicLandingPr("/r", 10, {
    state: "open",
    prNumber: 42,
    prUrl: "http://x/42",
    attempts: 0,
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingState).toBe("open");
  expect(row.landingPrNumber).toBe(42);
  expect(row.landingPrUrl).toBe("http://x/42");
  expect(row.landingAttempts).toBe(0);
});

test("setEpicLandingPr persists a non-zero attempts counter", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  s.setEpicLandingPr("/r", 10, {
    state: "error",
    prNumber: null,
    prUrl: null,
    attempts: 3,
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingState).toBe("error");
  expect(row.landingAttempts).toBe(3);
});

test("re-recordEpicCompleted preserves landing resolution by omission", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Old",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicLandingPr("/r", 10, {
    state: "open",
    prNumber: 42,
    prUrl: "http://x/42",
    attempts: 0,
  });

  // a later re-record refreshes title/children but must NOT reset the landing back to pending
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "New",
    completedAt: 999,
    childrenJson: "[1,2]",
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.parentTitle).toBe("New");
  expect(row.childrenJson).toBe("[1,2]");
  expect(row.landingState).toBe("open");
  expect(row.landingPrNumber).toBe(42);
});

test("fresh recordEpicCompleted defaults migration columns (empty paths, null ackedAt)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  const row = s.listEpicCompleted()[0]!;
  expect(row.migrationPaths).toEqual([]);
  expect(row.migrationsAckedAt).toBe(null);
});

test("setEpicMigrationPaths round-trips a detected-paths array", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicMigrationPaths("/r", 10, ["drizzle/0001.sql", "server/migrations/002.sql"]);
  const row = s.listEpicCompleted()[0]!;
  expect(row.migrationPaths).toEqual(["drizzle/0001.sql", "server/migrations/002.sql"]);
  expect(row.migrationsAckedAt).toBe(null); // detection alone doesn't acknowledge
});

test("re-recordEpicCompleted preserves migration columns by omission", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Old",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicMigrationPaths("/r", 10, ["drizzle/0001.sql", "server/migrations/002.sql"]);

  // detection populated the paths, ack is still pending
  const detected = s.listEpicCompleted()[0]!;
  expect(detected.migrationPaths).toEqual(["drizzle/0001.sql", "server/migrations/002.sql"]);
  expect(detected.migrationsAckedAt).toBe(null);

  // a later re-record refreshes title/children but must NOT wipe the migration columns
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "New",
    completedAt: 999,
    childrenJson: "[1,2]",
  });

  const row = s.listEpicCompleted()[0]!;
  expect(row.parentTitle).toBe("New");
  expect(row.childrenJson).toBe("[1,2]");
  // preserved by omission — the upsert touches neither migration column
  expect(row.migrationPaths).toEqual(["drizzle/0001.sql", "server/migrations/002.sql"]);
  expect(row.migrationsAckedAt).toBe(null);
});

test("re-recordEpicCompleted preserves a prior migrationsAckedAt by omission", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "Old",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicMigrationPaths("/r", 10, ["migrations/001.sql"]);
  s.ackEpicMigrations("/r", 10); // stamps migrationsAckedAt AND dismisses

  // helper to read the (now-dismissed, hidden) row straight from the DB
  const readRow = () =>
    (
      s as unknown as {
        db: { query: (q: string) => { get: (...a: unknown[]) => unknown } };
      }
    ).db
      .query(
        `SELECT migrationPathsJson, migrationsAckedAt FROM epic_completed WHERE repoPath = ? AND parentIssueNumber = ?`,
      )
      .get("/r", 10) as { migrationPathsJson: string | null; migrationsAckedAt: number | null };

  const acked = readRow();
  expect(acked.migrationsAckedAt).not.toBe(null);

  // re-record must not resurrect (stays dismissed) and must not wipe the ack timestamp/paths
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "New",
    completedAt: 999,
    childrenJson: "[1,2]",
  });
  expect(s.listEpicCompleted()).toHaveLength(0); // still dismissed, not resurrected

  const after = readRow();
  expect(after.migrationsAckedAt).toBe(acked.migrationsAckedAt); // ack survives the upsert
  expect(after.migrationPathsJson).toBe(JSON.stringify(["migrations/001.sql"]));
});

test("ackEpicMigrations stamps migrationsAckedAt AND clears the row from the list", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicMigrationPaths("/r", 10, ["migrations/001.sql"]);
  expect(s.listEpicCompleted()).toHaveLength(1);

  const before = Date.now();
  s.ackEpicMigrations("/r", 10);
  // acknowledging dismisses → gone from the (dismissedAt IS NULL) list
  expect(s.listEpicCompleted()).toHaveLength(0);

  // the ack timestamp is durably recorded even though the row is hidden
  const acked = (
    s as unknown as {
      db: { query: (q: string) => { get: (...a: unknown[]) => unknown } };
    }
  ).db
    .query(
      `SELECT migrationsAckedAt FROM epic_completed WHERE repoPath = ? AND parentIssueNumber = ?`,
    )
    .get("/r", 10) as { migrationsAckedAt: number };
  expect(acked.migrationsAckedAt).toBeGreaterThanOrEqual(before);
});

// ── setEpicLandingRebaseState ─────────────────────────────────────────────────

test("fresh recordEpicCompleted defaults rebase columns (0/0/null)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRebaseCount).toBe(0);
  expect(row.landingRebaseDriverMisses).toBe(0);
  expect(row.landingRebasePauseReason).toBe(null);
});

test("setEpicLandingRebaseState writes all three fields", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  s.setEpicLandingRebaseState("/r", 10, { count: 3, driverMisses: 1, pauseReason: "cap" });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRebaseCount).toBe(3);
  expect(row.landingRebaseDriverMisses).toBe(1);
  expect(row.landingRebasePauseReason).toBe("cap");
});

test("setEpicLandingRebaseState partial update — only count, preserves others", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  // seed all three fields
  s.setEpicLandingRebaseState("/r", 10, { count: 2, driverMisses: 1, pauseReason: "driver" });

  // partial update: bump count only
  s.setEpicLandingRebaseState("/r", 10, { count: 3 });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRebaseCount).toBe(3);
  expect(row.landingRebaseDriverMisses).toBe(1); // preserved
  expect(row.landingRebasePauseReason).toBe("driver"); // preserved
});

test("setEpicLandingRebaseState partial update — clear pauseReason to null", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicLandingRebaseState("/r", 10, { count: 2, driverMisses: 2, pauseReason: "conflict" });

  // clear pause reason and reset counters
  s.setEpicLandingRebaseState("/r", 10, { count: 0, driverMisses: 0, pauseReason: null });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRebaseCount).toBe(0);
  expect(row.landingRebaseDriverMisses).toBe(0);
  expect(row.landingRebasePauseReason).toBe(null);
});

test("setEpicLandingRebaseState partial update — driverMisses only, preserves count and pauseReason", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.setEpicLandingRebaseState("/r", 10, { count: 5, driverMisses: 0, pauseReason: "cap" });

  // bump driverMisses only
  s.setEpicLandingRebaseState("/r", 10, { driverMisses: 2 });

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRebaseCount).toBe(5); // preserved
  expect(row.landingRebaseDriverMisses).toBe(2);
  expect(row.landingRebasePauseReason).toBe("cap"); // preserved
});

// ── setEpicLandingRepairCount ───────────────────────────────────────────────

test("fresh recordEpicCompleted defaults repair columns (0/null)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRepairCount).toBe(0);
  expect(row.landingRepairHead).toBe(null);
});

test("setEpicLandingRepairCount writes both fields", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });

  s.setEpicLandingRepairCount("/r", 10, 1, "abc123");

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingRepairCount).toBe(1);
  expect(row.landingRepairHead).toBe("abc123");
});

test("setEpicLandingConflictReworkCount writes its own counter, CI-repair budget untouched (#1841)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  expect(s.listEpicCompleted()[0]!.landingConflictReworkCount).toBe(0);

  s.setEpicLandingConflictReworkCount("/r", 10, 1);

  const row = s.listEpicCompleted()[0]!;
  expect(row.landingConflictReworkCount).toBe(1);
  expect(row.landingRepairCount).toBe(0);
});

test("conflict pause stamps landingConflictSince once; any other reason clears both stamps (#1841)", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 10,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  const row = () => s.listEpicCompleted()[0]!;
  expect(row().landingConflictSince).toBeNull();
  expect(row().landingConflictEscalatedAt).toBeNull();

  s.setEpicLandingRebaseState("/r", 10, { pauseReason: "conflict", now: 100 });
  expect(row().landingConflictSince).toBe(100);
  // A repeat conflict write keeps the original start.
  s.setEpicLandingRebaseState("/r", 10, { pauseReason: "conflict", now: 500 });
  expect(row().landingConflictSince).toBe(100);
  s.setEpicLandingConflictEscalatedAt("/r", 10, 700);
  expect(row().landingConflictEscalatedAt).toBe(700);
  // Counter-only writes leave the stamps alone.
  s.setEpicLandingRebaseState("/r", 10, { count: 2 });
  expect(row().landingConflictSince).toBe(100);

  s.setEpicLandingRebaseState("/r", 10, { pauseReason: null });
  expect(row().landingConflictSince).toBeNull();
  expect(row().landingConflictEscalatedAt).toBeNull();

  s.setEpicLandingRebaseState("/r", 10, { pauseReason: "conflict", now: 900 });
  s.setEpicLandingConflictEscalatedAt("/r", 10, 950);
  s.setEpicLandingRebaseState("/r", 10, { pauseReason: "cap" });
  expect(row().landingConflictSince).toBeNull();
  expect(row().landingConflictEscalatedAt).toBeNull();
});

test("listEpicRuns returns all persisted epic_run rows", () => {
  const s = new SessionStore(":memory:");
  expect(s.listEpicRuns()).toEqual([]);
  s.setEpicRun({ repoPath: "/a", parentIssueNumber: 1, mode: "auto", status: "idle" });
  s.setEpicRun({ repoPath: "/b", parentIssueNumber: 2, mode: "attended", status: "running" });
  const runs = s.listEpicRuns().sort((x, y) => x.repoPath.localeCompare(y.repoPath));
  expect(runs).toEqual([
    {
      repoPath: "/a",
      parentIssueNumber: 1,
      mode: "auto",
      status: "idle",
      agentProvider: null,
      model: null,
      effort: null,
      ignoreUsageCeiling: false,
      landing: "integration",
    },
    {
      repoPath: "/b",
      parentIssueNumber: 2,
      mode: "attended",
      status: "running",
      agentProvider: null,
      model: null,
      effort: null,
      ignoreUsageCeiling: false,
      landing: "integration",
    },
  ]);
});

// ── #3838: success outcome, acknowledgement and history ──

function landed(s: SessionStore, parent: number, repoPath = "/r"): void {
  s.recordEpicCompleted({
    repoPath,
    parentIssueNumber: parent,
    parentTitle: `Epic ${parent}`,
    completedAt: 1000 + parent,
    childrenJson: "[]",
  });
  s.setEpicLandingPr(repoPath, parent, {
    state: "merged",
    prNumber: 40 + parent,
    prUrl: null,
    attempts: 1,
  });
}

test("#3838: a merged landing marks the row landed with a success time, once", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 1,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  expect(s.listEpicCompleted()[0]).toMatchObject({
    outcome: null,
    succeededAt: null,
    acknowledgedAt: null,
  });
  s.setEpicLandingPr("/r", 1, { state: "open", prNumber: 5, prUrl: null, attempts: 1 });
  expect(s.listEpicCompleted()[0]!.outcome).toBeNull();
  s.setEpicLandingPr("/r", 1, { state: "merged", prNumber: 5, prUrl: null, attempts: 1 });
  const first = s.listEpicCompleted()[0]!;
  expect(first.outcome).toBe("landed");
  expect(first.succeededAt).toBeNumber();
  s.setEpicLandingPr("/r", 1, { state: "merged", prNumber: 5, prUrl: null, attempts: 1 });
  expect(s.listEpicCompleted()[0]!.succeededAt).toBe(first.succeededAt);
});

test("#3838: acknowledging takes a success out of the band; history keeps it", () => {
  const s = new SessionStore(":memory:");
  landed(s, 1);
  landed(s, 2, "/other");
  expect(s.listEpicCompleted("/r").map((r) => r.parentIssueNumber)).toEqual([1]);
  expect(s.acknowledgeEpicCompleted("/r", 1)).toBe(true);
  expect(s.listEpicCompleted("/r")).toEqual([]);
  expect(s.listEpicHistory("/r")).toMatchObject([{ parentIssueNumber: 1, outcome: "landed" }]);
  expect(s.listEpicHistory("/r")[0]!.acknowledgedAt).toBeNumber();
  // History respects the repo filter; the unacknowledged one is listed too.
  expect(s.listEpicHistory("/other")).toMatchObject([
    { parentIssueNumber: 2, acknowledgedAt: null },
  ]);
  expect(s.listEpicHistory().map((r) => r.parentIssueNumber)).toEqual([2, 1]);
});

test("#3838: only a success can be acknowledged", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 1,
    parentTitle: "E",
    completedAt: 1,
    childrenJson: "[]",
  });
  expect(s.acknowledgeEpicCompleted("/r", 1)).toBe(false);
  expect(s.acknowledgeEpicCompleted("/r", 99)).toBe(false);
  expect(s.listEpicCompleted()).toHaveLength(1);
});

test("#3838: an operator's remove or migrations ack of a success also acknowledges it", () => {
  const s = new SessionStore(":memory:");
  landed(s, 1);
  landed(s, 2);
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 3,
    parentTitle: "open",
    completedAt: 1,
    childrenJson: "[]",
  });
  s.dismissEpicCompleted("/r", 1);
  s.ackEpicMigrations("/r", 2);
  s.dismissEpicCompleted("/r", 3);
  const acked = s
    .listEpicHistory("/r")
    .map((r) => [r.parentIssueNumber, r.acknowledgedAt !== null]);
  expect(acked).toEqual([
    [2, true],
    [1, true],
  ]);
});

test("#3838: an incremental success is terminal with nothing to land", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicCompleted({
    repoPath: "/r",
    parentIssueNumber: 7,
    parentTitle: "Inc",
    completedAt: 500,
    childrenJson: "[]",
  });
  s.markEpicIncrementalSucceeded("/r", 7, 500);
  expect(s.listEpicCompleted()[0]).toMatchObject({
    landingState: "none",
    outcome: "incremental",
    succeededAt: 500,
  });
});

test("#3838: outcome, success time and acknowledgement survive a store reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-epic-success-"));
  const dbPath = join(dir, "test.db");
  try {
    const s1 = new SessionStore(dbPath);
    landed(s1, 1);
    landed(s1, 2);
    s1.acknowledgeEpicCompleted("/r", 2);
    const before = s1.listEpicHistory("/r");

    const s2 = new SessionStore(dbPath);
    expect(s2.listEpicHistory("/r")).toEqual(before);
    expect(s2.listEpicCompleted("/r")).toMatchObject([
      { parentIssueNumber: 1, outcome: "landed", acknowledgedAt: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#3838: a pre-existing merged row backfills to landed at its clock's landedAt", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-epic-backfill-"));
  const dbPath = join(dir, "test.db");
  try {
    const s1 = new SessionStore(dbPath);
    landed(s1, 1);
    s1.recordEpicCompleted({
      repoPath: "/r",
      parentIssueNumber: 2,
      parentTitle: "open",
      completedAt: 7,
      childrenJson: "[]",
    });
    // Rewind to the schema before #3838: no outcome columns.
    const db = new Database(dbPath);
    db.run(`UPDATE epic_completed SET dismissedAt = 99 WHERE parentIssueNumber = 1`);
    db.run(`INSERT INTO epic_clock (repoPath, parentIssueNumber, startedAt, landedAt)
            VALUES ('/r', 1, 0, 4242)`);
    for (const c of ["outcome", "succeededAt", "acknowledgedAt"])
      db.run(`ALTER TABLE epic_completed DROP COLUMN ${c}`);
    db.close();

    const s2 = new SessionStore(dbPath);
    expect(s2.listEpicHistory("/r")).toMatchObject([
      { parentIssueNumber: 1, outcome: "landed", succeededAt: 4242, acknowledgedAt: null },
    ]);
    expect(s2.listEpicCompleted("/r")).toMatchObject([{ parentIssueNumber: 2, outcome: null }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
