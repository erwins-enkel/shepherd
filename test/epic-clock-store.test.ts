import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import type { EpicRun } from "../src/epic-core";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const at = (min: number) => setSystemTime(new Date(T0 + min * MIN));

afterEach(() => setSystemTime());

const run = (parentIssueNumber: number, status: EpicRun["status"], extra = {}): EpicRun => ({
  repoPath: "/repo",
  parentIssueNumber,
  mode: "auto",
  status,
  ...extra,
});

function completed(s: SessionStore, parent: number, completedAt: number) {
  s.recordEpicCompleted({
    repoPath: "/repo",
    parentIssueNumber: parent,
    parentTitle: "epic",
    completedAt,
    childrenJson: "[]",
  });
}

describe("epic clock transitions (setEpicRun)", () => {
  test("start → pause 10 min → resume → complete counts the pause, never the paused time", () => {
    const s = new SessionStore(":memory:");
    at(0);
    s.setEpicRun(run(1, "running"));
    at(30);
    s.setEpicRun(run(1, "paused"));
    expect(s.getEpicClock("/repo", 1)).toMatchObject({ pausedAt: T0 + 30 * MIN, pauses: [] });
    at(40);
    s.setEpicRun(run(1, "running"));
    at(70);
    s.setEpicRun(run(1, "idle"), { completed: true });
    const clock = s.getEpicClock("/repo", 1)!;
    expect(clock.startedAt).toBe(T0);
    expect(clock.pauses).toEqual([[T0 + 30 * MIN, T0 + 40 * MIN]]);
    expect(clock.pausedAt).toBe(T0 + 70 * MIN);
    const pausedMs = clock.pauses.reduce((ms, [a, b]) => ms + b - a, 0);
    expect(pausedMs).toBe(10 * MIN);
    // running time = stop − start − paused
    expect(clock.pausedAt! - clock.startedAt - pausedMs).toBe(60 * MIN);
  });

  test("a supersede keeps A's clock; resuming A continues it without resetting startedAt", () => {
    const s = new SessionStore(":memory:");
    at(0);
    s.setEpicRun(run(1, "running"));
    at(20);
    s.setEpicRun(run(2, "running")); // B supersedes A
    expect(s.getEpicClock("/repo", 1)).toMatchObject({ startedAt: T0, pausedAt: T0 + 20 * MIN });
    expect(s.getEpicClock("/repo", 2)).toMatchObject({ startedAt: T0 + 20 * MIN, pausedAt: null });
    at(50);
    s.setEpicRun(run(1, "running")); // A again supersedes B
    expect(s.getEpicClock("/repo", 1)).toEqual({
      startedAt: T0,
      pausedAt: null,
      pauses: [[T0 + 20 * MIN, T0 + 50 * MIN]],
      landingStartedAt: null,
      landedAt: null,
      firstFinishAt: null,
    });
    expect(s.getEpicClock("/repo", 2)!.pausedAt).toBe(T0 + 50 * MIN);
  });

  test("ending stops the clock; a later restart continues it", () => {
    const s = new SessionStore(":memory:");
    at(0);
    s.setEpicRun(run(1, "running"));
    at(5);
    s.setEpicRun(run(1, "idle"));
    expect(s.getEpicClock("/repo", 1)!.pausedAt).toBe(T0 + 5 * MIN);
    at(9);
    s.setEpicRun(run(1, "running"));
    expect(s.getEpicClock("/repo", 1)).toMatchObject({
      startedAt: T0,
      pausedAt: null,
      pauses: [[T0 + 5 * MIN, T0 + 9 * MIN]],
    });
  });

  test("a settings edit on a running or paused epic leaves its clock untouched", () => {
    const s = new SessionStore(":memory:");
    at(0);
    s.setEpicRun(run(1, "running"));
    at(5);
    s.setEpicRun(run(1, "running", { agentProvider: "codex", model: "gpt-5.5" }));
    expect(s.getEpicClock("/repo", 1)).toMatchObject({ startedAt: T0, pausedAt: null });
    s.setEpicRun(run(1, "paused"));
    at(8);
    s.setEpicRun(run(1, "paused", { mode: "attended" }));
    expect(s.getEpicClock("/repo", 1)).toMatchObject({ pausedAt: T0 + 5 * MIN, pauses: [] });
  });

  test("an epic that never ran has no clock, even when paused or idle", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "idle"));
    s.setEpicRun(run(2, "paused"));
    expect(s.getEpicClock("/repo", 1)).toBeNull();
    expect(s.getEpicClock("/repo", 2)).toBeNull();
  });
});

describe("epic clock landing stamps", () => {
  test("the first completion stamps landingStartedAt; a merged landing stamps landedAt once", () => {
    const s = new SessionStore(":memory:");
    at(0);
    s.setEpicRun(run(1, "running"));
    completed(s, 1, T0 + 60 * MIN);
    completed(s, 1, T0 + 65 * MIN); // idempotent re-record keeps the first stamp
    expect(s.getEpicClock("/repo", 1)!.landingStartedAt).toBe(T0 + 60 * MIN);
    at(70);
    s.setEpicLandingPr("/repo", 1, { state: "open", prNumber: 9, prUrl: "u", attempts: 0 });
    expect(s.getEpicClock("/repo", 1)!.landedAt).toBeNull();
    at(90);
    s.setEpicLandingPr("/repo", 1, { state: "merged", prNumber: 9, prUrl: "u", attempts: 0 });
    at(95);
    s.setEpicLandingPr("/repo", 1, { state: "merged", prNumber: 9, prUrl: "u", attempts: 0 });
    expect(s.getEpicClock("/repo", 1)!.landedAt).toBe(T0 + 90 * MIN);
  });

  test("a restart that drops a stale completion clears the landing stamp", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "running"));
    completed(s, 1, 1000);
    expect(s.clearEpicCompletedOnRestart("/repo", 1)).toBe(true);
    expect(s.getEpicClock("/repo", 1)!.landingStartedAt).toBeNull();
  });

  test("a restart under an open landing PR keeps the completion and its stamp", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "running"));
    completed(s, 1, 1000);
    s.setEpicLandingPr("/repo", 1, { state: "open", prNumber: 9, prUrl: "u", attempts: 0 });
    expect(s.clearEpicCompletedOnRestart("/repo", 1)).toBe(false);
    expect(s.getEpicClock("/repo", 1)!.landingStartedAt).toBe(1000);
  });

  test("an epic without a clock gets no landing stamps (and no clock)", () => {
    const s = new SessionStore(":memory:");
    completed(s, 1, 1000);
    s.setEpicLandingPr("/repo", 1, { state: "merged", prNumber: 9, prUrl: "u", attempts: 0 });
    expect(s.getEpicClock("/repo", 1)).toBeNull();
  });
});

describe("epic forecast inputs", () => {
  test("the drift anchor: first write wins, and an epic without a clock gets none", () => {
    const s = new SessionStore(":memory:");
    s.setEpicRun(run(1, "running"));
    s.recordEpicFirstFinish("/repo", 1, 5000);
    s.recordEpicFirstFinish("/repo", 1, 9000);
    expect(s.getEpicClock("/repo", 1)!.firstFinishAt).toBe(5000);
    s.recordEpicFirstFinish("/repo", 2, 5000);
    expect(s.getEpicClock("/repo", 2)).toBeNull();
  });

  test("landing durations: the repo's landed epics only", () => {
    const s = new SessionStore(":memory:");
    const land = (parent: number, from: number, to: number | null) => {
      s.setEpicRun(run(parent, "running"));
      completed(s, parent, from);
      at(to ?? 0);
      if (to != null)
        s.setEpicLandingPr("/repo", parent, {
          state: "merged",
          prNumber: 9,
          prUrl: "u",
          attempts: 0,
        });
    };
    land(1, T0, 30);
    land(2, T0 + 60 * MIN, 70);
    land(3, T0 + 80 * MIN, null); // still landing
    s.setEpicRun({ ...run(4, "running"), repoPath: "/other" });
    expect(s.listEpicLandingDurations("/repo").sort((a, b) => a - b)).toEqual([10 * MIN, 30 * MIN]);
    expect(s.listEpicLandingDurations("/other")).toEqual([]);
  });
});

describe("listDeliveryFactsForIssues", () => {
  test("returns one repo's facts for the given issues only", () => {
    const s = new SessionStore(":memory:");
    const fact = (sessionId: string, repoPath: string, issueNumber: number | null) =>
      s.upsertDeliveryFact({ sessionId, repoPath, desig: "", issueNumber, createdAt: 1, now: 1 });
    fact("a", "/repo", 2);
    fact("b", "/repo", 3);
    fact("c", "/other", 2);
    fact("d", "/repo", null);
    expect(
      s
        .listDeliveryFactsForIssues("/repo", [2, 3])
        .map((f) => f.sessionId)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(s.listDeliveryFactsForIssues("/repo", [])).toEqual([]);
  });
});

describe("epic_clock migration", () => {
  const dbPath = () => join(mkdtempSync(join(tmpdir(), "epic-clock-")), "s.db");

  function session(s: SessionStore, issueNumber: number, extra: Record<string, unknown> = {}) {
    return s.create({
      name: "t",
      prompt: "p",
      repoPath: "/repo",
      baseBranch: "main",
      branch: `shepherd/t-${issueNumber}`,
      worktreePath: "/wt",
      isolated: true,
      herdrSession: "h",
      herdrAgentId: "term_1",
      auto: true,
      issueNumber,
      ...extra,
    } as never);
  }

  /** Simulate a DB from before the epic clock shipped, seed it, and reopen. */
  function preClock(path: string, seed: (raw: Database) => void): SessionStore {
    const raw = new Database(path);
    raw.run(`DROP TABLE epic_clock`);
    seed(raw);
    raw.close();
    return new SessionStore(path);
  }

  const epicRun = (raw: Database, parent: number, status: string, updatedAt: number) =>
    raw.run(
      `INSERT INTO epic_run (repoPath, parentIssueNumber, mode, status, updatedAt) VALUES (?,?,?,?,?)`,
      ["/repo", parent, "auto", status, updatedAt],
    );

  test("a fresh DB has the table and no clocks", () => {
    const path = dbPath();
    new SessionStore(path);
    const raw = new Database(path);
    expect(raw.query(`SELECT COUNT(*) AS n FROM epic_clock`).get()).toEqual({ n: 0 });
    raw.close();
  });

  test("an existing DB gains the table; an existing clock is never overwritten on reopen", () => {
    const path = dbPath();
    at(0);
    const s = new SessionStore(path);
    s.setEpicRun(run(1, "running"));
    const before = s.getEpicClock("/repo", 1);
    at(100);
    expect(new SessionStore(path).getEpicClock("/repo", 1)).toEqual(before);

    const upgraded = preClock(path, () => {});
    // the dropped table is recreated and the still-running epic is backfilled
    expect(upgraded.getEpicClock("/repo", 1)).not.toBeNull();
  });

  test("a clock from before the drift anchor gains the column and keeps its row", () => {
    const path = dbPath();
    at(0);
    new SessionStore(path).setEpicRun(run(1, "running"));
    const raw = new Database(path);
    raw.run(`ALTER TABLE epic_clock DROP COLUMN firstFinishAt`);
    raw.close();
    const upgraded = new SessionStore(path);
    expect(upgraded.getEpicClock("/repo", 1)).toMatchObject({ startedAt: T0, firstFinishAt: null });
    upgraded.recordEpicFirstFinish("/repo", 1, 5000);
    expect(upgraded.getEpicClock("/repo", 1)!.firstFinishAt).toBe(5000);
  });

  test("an epic already running starts at its earliest known child start", () => {
    const path = dbPath();
    const s = new SessionStore(path);
    at(10);
    session(s, 2, { epicParent: 1 }); // stamped epic child
    at(5);
    session(s, 3, { baseBranch: "epic/1-thing" }); // legacy child, named by its base branch
    at(1);
    session(s, 4, { epicParent: 99 }); // another epic's child — ignored
    s.upsertDeliveryFact({
      sessionId: "pruned",
      repoPath: "/repo",
      desig: "",
      issueNumber: 7, // integrated child whose session row is gone
      createdAt: T0 + 3 * MIN,
      now: T0,
    });
    s.recordEpicIntegrated("/repo", 1, 7);
    const upgraded = preClock(path, (raw) => epicRun(raw, 1, "running", T0 + 60 * MIN));
    expect(upgraded.getEpicClock("/repo", 1)).toEqual({
      startedAt: T0 + 3 * MIN,
      pausedAt: null,
      pauses: [],
      landingStartedAt: null,
      landedAt: null,
      firstFinishAt: null,
    });
  });

  test("a paused epic is backfilled stopped at its last run write", () => {
    const path = dbPath();
    const s = new SessionStore(path);
    at(10);
    session(s, 2, { epicParent: 1 });
    const upgraded = preClock(path, (raw) => epicRun(raw, 1, "paused", T0 + 60 * MIN));
    expect(upgraded.getEpicClock("/repo", 1)).toMatchObject({
      startedAt: T0 + 10 * MIN,
      pausedAt: T0 + 60 * MIN,
    });
  });

  test("with no child data the start is the run row's updatedAt; an idle run gets no clock", () => {
    const path = dbPath();
    new SessionStore(path);
    const upgraded = preClock(path, (raw) => {
      epicRun(raw, 1, "running", T0 + 60 * MIN);
      raw.run(
        `INSERT INTO epic_run (repoPath, parentIssueNumber, mode, status, updatedAt) VALUES (?,?,?,?,?)`,
        ["/other", 5, "auto", "idle", T0],
      );
    });
    expect(upgraded.getEpicClock("/repo", 1)!.startedAt).toBe(T0 + 60 * MIN);
    expect(upgraded.getEpicClock("/other", 5)).toBeNull();
  });
});
