import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { buildDeliveryMetrics } from "../src/delivery-metrics";
import type { ReviewerSpawnOutcome } from "../src/types";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function mk(): SessionStore {
  return new SessionStore(":memory:");
}

/** Seed one merged task: its fact row plus `outcomes` in spawn order. */
function seedTask(
  store: SessionStore,
  opts: {
    id: string;
    repoPath?: string;
    createdAt: number;
    prOpenedAt?: number | null;
    mergedAt: number;
    reviews?: { outcome: ReviewerSpawnOutcome | null; spawnedAt: number }[];
    planRounds?: (ReviewerSpawnOutcome | null)[];
  },
): void {
  store.upsertDeliveryFact({
    sessionId: opts.id,
    repoPath: opts.repoPath ?? "/repos/alpha",
    desig: opts.id.toUpperCase(),
    issueNumber: null,
    prNumber: 7,
    createdAt: opts.createdAt,
    prOpenedAt: opts.prOpenedAt ?? null,
    mergedAt: opts.mergedAt,
    now: opts.mergedAt,
  });
  (opts.reviews ?? []).forEach((r, i) => {
    const rid = `${opts.id}-rev-${i}`;
    store.recordReviewerSpawn({
      reviewerSessionId: rid,
      taskSessionId: opts.id,
      kind: "review",
      worktreePath: "/wt",
      model: null,
      spawnedAt: r.spawnedAt,
    });
    if (r.outcome) store.setReviewerSpawnOutcome(rid, r.outcome);
  });
  (opts.planRounds ?? []).forEach((outcome, i) => {
    const rid = `${opts.id}-plan-${i}`;
    store.recordReviewerSpawn({
      reviewerSessionId: rid,
      taskSessionId: opts.id,
      kind: "plan_gate",
      worktreePath: "/wt",
      model: null,
      spawnedAt: opts.createdAt + i,
    });
    if (outcome) store.setReviewerSpawnOutcome(rid, outcome);
  });
}

function build(store: SessionStore, range: "24h" | "7d" | "30d" | "all" = "7d") {
  return buildDeliveryMetrics({ store, range, now: NOW });
}

test("empty store yields null metrics, not zeros", () => {
  const m = build(mk());
  expect(m.totals.mergedTasks).toBe(0);
  expect(m.totals.firstPassRate.value).toBeNull();
  expect(m.totals.firstPassRate.n).toBe(0);
  expect(m.totals.leadTimeMs.value).toBeNull();
  expect(m.totals.reworkCyclesMedian.value).toBeNull();
  expect(m.measuringSince).toBeNull();
  expect(m.repos).toEqual([]);
  expect(m.tasks).toEqual([]);
});

test("one clean review round = first pass; three rounds = not first pass", () => {
  const s = mk();
  seedTask(s, {
    id: "clean",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    reviews: [{ outcome: "clean", spawnedAt: NOW - DAY + 1000 }],
  });
  seedTask(s, {
    id: "rework",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    reviews: [
      { outcome: "changes_requested", spawnedAt: NOW - DAY + 1000 },
      { outcome: "changes_requested", spawnedAt: NOW - DAY + 2000 },
      { outcome: "clean", spawnedAt: NOW - DAY + 3000 },
    ],
  });
  const m = build(s);
  expect(m.totals.mergedTasks).toBe(2);
  expect(m.totals.firstPassRate).toEqual({ value: 0.5, n: 2 });
  expect(m.totals.reworkCyclesMedian).toEqual({ value: 2, n: 2 });
  expect(m.totals.reworkCyclesMean).toEqual({ value: 2, n: 2 });
  const rework = m.tasks.find((t) => t.sessionId === "rework")!;
  expect(rework.firstPass).toBe(false);
  expect(rework.reviewRounds).toBe(3);
});

test("a crashed critic spawn is NOT a rework cycle", () => {
  const s = mk();
  seedTask(s, {
    id: "crashy",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    reviews: [
      { outcome: "error", spawnedAt: NOW - DAY + 500 },
      { outcome: "clean", spawnedAt: NOW - DAY + 1000 },
    ],
  });
  const m = build(s);
  // Two spawn rows, but only ONE verdict — a raw spawn tally would have read this as rework.
  expect(m.totals.reworkCyclesMedian.value).toBe(1);
  expect(m.totals.firstPassRate.value).toBe(1);
  expect(m.totals.criticErrors).toBe(1);
});

test("a spawn that never finalized (NULL outcome) is unknown, not clean", () => {
  const s = mk();
  seedTask(s, {
    id: "orphan",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    reviews: [{ outcome: null, spawnedAt: NOW - DAY + 500 }],
  });
  const m = build(s);
  expect(m.totals.unreviewed).toBe(1);
  expect(m.totals.firstPassRate).toEqual({ value: null, n: 0 });
  expect(m.tasks[0]!.firstPass).toBeNull();
});

test("unreviewed merged tasks stay out of the first-pass denominator", () => {
  const s = mk();
  seedTask(s, { id: "bare", createdAt: NOW - DAY, mergedAt: NOW - DAY / 2 });
  seedTask(s, {
    id: "reviewed",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    reviews: [{ outcome: "clean", spawnedAt: NOW - DAY + 10 }],
  });
  const m = build(s);
  expect(m.totals.mergedTasks).toBe(2);
  expect(m.totals.unreviewed).toBe(1);
  expect(m.totals.firstPassRate).toEqual({ value: 1, n: 1 });
});

test("plan rework counts only verdict-bearing gate rounds", () => {
  const s = mk();
  seedTask(s, {
    id: "gated",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    planRounds: ["rework", "approved", "error", null],
  });
  seedTask(s, { id: "ungated", createdAt: NOW - DAY, mergedAt: NOW - DAY / 2 });
  const m = build(s);
  expect(m.totals.planRoundsMedian).toEqual({ value: 2, n: 1 });
  expect(m.totals.planReworkRate).toEqual({ value: 1, n: 1 });
});

test("lead time and time-to-first-review are measured; inverted pairs are dropped", () => {
  const s = mk();
  seedTask(s, {
    id: "ok",
    createdAt: NOW - 4 * 3_600_000,
    prOpenedAt: NOW - 3 * 3_600_000,
    mergedAt: NOW - 3_600_000,
    reviews: [{ outcome: "clean", spawnedAt: NOW - 3 * 3_600_000 + 600_000 }],
  });
  seedTask(s, {
    id: "inverted",
    createdAt: NOW - 4 * 3_600_000,
    // PR-open observed AFTER the critic spawned — bad data, must be dropped rather than clamped.
    prOpenedAt: NOW - 3_600_000,
    mergedAt: NOW - 1_800_000,
    reviews: [{ outcome: "clean", spawnedAt: NOW - 3 * 3_600_000 }],
  });
  const m = build(s);
  expect(m.totals.timeToFirstReviewMs).toEqual({ value: 600_000, n: 1 });
  expect(m.totals.leadTimeMs.n).toBe(2);
  // median of 3h ('ok') and 3.5h ('inverted') — the inverted PAIR only drops the ttfr sample
  expect(m.totals.leadTimeMs.value).toBe(3.25 * 3_600_000);
});

test("window filters on the exact cutoff and 'all' includes everything", () => {
  const s = mk();
  seedTask(s, { id: "old", createdAt: NOW - 40 * DAY, mergedAt: NOW - 40 * DAY });
  seedTask(s, { id: "recent", createdAt: NOW - 2 * DAY, mergedAt: NOW - 2 * DAY });
  // exactly ON the 7d boundary → included (>= cutoff)
  seedTask(s, { id: "edge", createdAt: NOW - 7 * DAY, mergedAt: NOW - 7 * DAY });
  expect(build(s, "24h").totals.mergedTasks).toBe(0);
  expect(build(s, "7d").totals.mergedTasks).toBe(2);
  expect(build(s, "30d").totals.mergedTasks).toBe(2);
  const all = build(s, "all");
  expect(all.totals.mergedTasks).toBe(3);
  expect(all.since).toBe(0);
});

test("unmerged tasks are excluded entirely", () => {
  const s = mk();
  s.upsertDeliveryFact({
    sessionId: "open",
    repoPath: "/repos/alpha",
    desig: "TASK-99",
    issueNumber: null,
    prNumber: 3,
    createdAt: NOW - DAY,
    prOpenedAt: NOW - DAY,
    now: NOW,
  });
  const m = build(s);
  expect(m.totals.mergedTasks).toBe(0);
  // ...but it still counts as instrumented, so the "measuring since" note is honest.
  expect(m.measuringSince).toBe(NOW - DAY);
});

test("repos are split, named by basename, and sorted by merged volume", () => {
  const s = mk();
  seedTask(s, { id: "a1", repoPath: "/repos/alpha", createdAt: NOW - DAY, mergedAt: NOW - DAY });
  seedTask(s, { id: "a2", repoPath: "/repos/alpha", createdAt: NOW - DAY, mergedAt: NOW - DAY });
  seedTask(s, { id: "b1", repoPath: "/repos/beta", createdAt: NOW - DAY, mergedAt: NOW - DAY });
  const m = build(s);
  expect(m.repos.map((r) => r.repo)).toEqual(["alpha", "beta"]);
  expect(m.repos[0]!.mergedTasks).toBe(2);
  expect(m.repos[1]!.repoPath).toBe("/repos/beta");
});

test("trend buckets by UTC day, oldest first", () => {
  const s = mk();
  seedTask(s, { id: "d1", createdAt: NOW - 3 * DAY, mergedAt: NOW - 3 * DAY });
  seedTask(s, { id: "d2a", createdAt: NOW - DAY, mergedAt: NOW - DAY });
  seedTask(s, { id: "d2b", createdAt: NOW - DAY, mergedAt: NOW - DAY + 1000 });
  const m = build(s);
  expect(m.trend.length).toBe(2);
  expect(m.trend[0]!.dayKey < m.trend[1]!.dayKey).toBe(true);
  expect(m.trend[1]!.mergedTasks).toBe(2);
});

test("repeat incidents group signals by kind with distinct sessions", () => {
  const s = mk();
  seedTask(s, { id: "t1", createdAt: NOW - DAY, mergedAt: NOW - DAY });
  for (const sessionId of ["t1", "t1", "t2"])
    s.addSignal({ repoPath: "/repos/alpha", sessionId, kind: "stall", payload: "x" });
  s.addSignal({ repoPath: "/repos/beta", sessionId: null, kind: "critic", payload: "y" });
  const m = build(s, "all");
  const stall = m.incidents.find((i) => i.kind === "stall")!;
  expect(stall.occurrences).toBe(3);
  expect(stall.sessions).toBe(2);
  expect(m.incidents.find((i) => i.kind === "critic")!.sessions).toBe(0);
});

test("only this task's spawns count toward its rounds", () => {
  const s = mk();
  seedTask(s, {
    id: "mine",
    createdAt: NOW - DAY,
    mergedAt: NOW - DAY / 2,
    reviews: [{ outcome: "clean", spawnedAt: NOW - DAY }],
  });
  // A spawn belonging to a session with no fact row must not leak into anyone's tally.
  s.recordReviewerSpawn({
    reviewerSessionId: "stray",
    taskSessionId: "someone-else",
    kind: "review",
    worktreePath: "/wt",
    model: null,
    spawnedAt: NOW - DAY,
  });
  s.setReviewerSpawnOutcome("stray", "changes_requested");
  const m = build(s);
  expect(m.totals.reworkCyclesMedian).toEqual({ value: 1, n: 1 });
  expect(m.totals.firstPassRate.value).toBe(1);
});
