import { test, expect } from "bun:test";
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
    },
    {
      repoPath: "/b",
      parentIssueNumber: 2,
      mode: "attended",
      status: "running",
      agentProvider: null,
      model: null,
      effort: null,
    },
  ]);
});
